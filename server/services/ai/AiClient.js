const OpenAI = require('openai');
const { normalizePricingBlock } = require('./priceCatalog');

/**
 * Transport client for communication with AI providers (OpenAI-compatible).
 * Responsible only for: sending messages, receiving responses, and managing streams.
 *
 * Contains no business logic — only pure transport.
 */
class AiClient {
  /**
   * @param {import('./types').AiClientConfig} config - Client configuration
   */
  constructor(config) {
    if (!config.baseUrl) {
      throw new Error('baseUrl is required');
    }

    if (!config.apiKey) {
      throw new Error('apiKey is required for remote providers');
    }

    this.config = {
      apiKey: config.apiKey || 'dummy', // Valor dummy para providers locais
      baseUrl: config.baseUrl,
      model: config.model || null,
      timeout: config.timeout || 600000, // 10 minutos
      maxRetries: config.maxRetries || 3,
      retryBaseDelay: config.retryBaseDelay || 5000, // base p/ backoff exponencial em 5xx
    };

    // Inicializar cliente OpenAI
    this.openai = new OpenAI({
      apiKey: this.config.apiKey,
      baseURL: this.config.baseUrl,
      timeout: this.config.timeout,
      maxRetries: this.config.maxRetries || 3, // Delegar retries no SDK
    });
  }

  /**
   * Synchronous chat completion (simple POST).
   * @param {import('./types').ChatCompletionRequest} params
   * @returns {Promise<import('./types').ChatCompletionResponse>}
   */
  async chatCompletion(params) {
    const { model, messages, tools, maxTokens, signal, reasoning } = params;

    // Prepare parameters for the request
    const requestParams = {
      model: model || this.config.model,
      messages,
      max_tokens: maxTokens || 8192,
    };

    if (tools && tools.length > 0) {
      requestParams.tools = tools;
    }

    // Apply reasoning/thinking configuration (OpenRouter-compatible)
    this._applyReasoningToRequest(requestParams, reasoning);

    // Retries are managed by the SDK (maxRetries configured in constructor).
    let response;
    try {
      response = await this.openai.chat.completions.create(requestParams, {
        signal
      });
    } catch (error) {
      throw error; // Propagar erro para o caller decidir como tratar
    }

    // Normalizar resposta
    return this._normalizeChatResponse(response);
  }

  /**
   * Chat completion com streaming.
   * @param {import('./types').ChatCompletionRequest} params
   * @param {(chunk: import('./types').StreamingChunk) => void} onChunk - Callback chamado a cada chunk
   * @returns {Promise<void>}
   */
  async chatCompletionStream(params, onChunk) {
    const { model, messages, tools, maxTokens, signal, reasoning } = params;

    // Prepare parameters for the request
    const requestParams = {
      model: model || this.config.model,
      messages,
      max_tokens: maxTokens || 8192,
      stream: true, // Habilitar streaming
      // Some providers only report usage when this is set. Kilo reports it in the
      // finish_reason chunk regardless, so this is additive, not a replacement.
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      requestParams.tools = tools;
    }

    // Apply reasoning/thinking configuration (OpenRouter-compatible)
    this._applyReasoningToRequest(requestParams, reasoning);

    try {
      let stream;
      try {
        stream = await this.openai.chat.completions.create(requestParams, {
          signal
        });
      } catch (error) {
        // Strict providers may reject the unknown `stream_options` field.
        if (this._isUnsupportedStreamOptions(error)) {
          delete requestParams.stream_options;
          stream = await this.openai.chat.completions.create(requestParams, {
            signal
          });
        } else {
          throw error;
        }
      }

      // Processar o stream
      await this._processStream(stream, onChunk, signal);

    } catch (error) {
      if (signal?.aborted || this._isAbortError(error)) {
        throw error;
      }

      const structuredError = this._buildStructuredError(error);
      onChunk({
        type: 'error',
        error: structuredError,
      });
      throw error;
    }
  }

  /**
   * Lists models available on the provider.
   * @returns {Promise<Array<import('./types').ModelInfo>>}
   */
  async listModels() {
    try {
      const response = await this.openai.models.list();

      // Normalizar para formato consistente
      // Muitos providers (OpenRouter, LiteLLM, Kilo, etc.) devolvem context_length / max_model_input_tokens
      const normalized = response.data.map(model => {
        const rawContext =
          model.context_length ||
          model.max_model_input_tokens ||
          model.contextWindow ||
          model.max_tokens;

        const supportedParameters = Array.isArray(model.supported_parameters)
          ? model.supported_parameters.map(item => String(item).toLowerCase())
          : [];

        const reasoningParameters = supportedParameters.filter(param =>
          param === 'reasoning' || param === 'include_reasoning' || param === 'reasoning_effort'
        );

        const thinkingModes = this._buildThinkingModes(model);

        const reasoningInfo = model.reasoning
          ? {
              mandatory: Boolean(model.reasoning.mandatory),
              defaultEnabled: model.reasoning.default_enabled !== undefined
                ? Boolean(model.reasoning.default_enabled)
                : undefined,
              supportedEfforts: Array.isArray(model.reasoning.supported_efforts)
                ? model.reasoning.supported_efforts.map(e => String(e))
                : undefined,
              defaultEffort: model.reasoning.default_effort
                ? String(model.reasoning.default_effort)
                : undefined,
            }
          : undefined;

        // Pricing do provider API (OpenRouter/Kilo devolvem $/token em strings).
        // A normalização é feita por `priceCatalog` (mesma regra da referência do Kilo):
        // conversão incondicional de $/token para $/1M tokens, negativos = preço desconhecido.
        const pricing = normalizePricingBlock(model.pricing);

        return {
          id: model.id,
          name: model.name || model.id,
          contextWindow: rawContext || this._estimateContextWindow(model.id),
          supportsReasoning: thinkingModes && thinkingModes.length > 1,
          reasoningParameters,
          hasInternalReasoning: Boolean(model.pricing?.internal_reasoning),
          reasoning: reasoningInfo,
          thinkingModes,
          pricing: pricing || undefined,
        };
      });

      return normalized;
    } catch (error) {
      throw this._buildStructuredError(error);
    }
  }

  /**
   * Gets the real context length of a specific model.
   * Tries provider data first; if not available, estimates.
   */
  async getModelContextLength(modelId) {
    try {
      const models = await this.listModels();
      const found = models.find(m => m.id === modelId || m.name === modelId);
      if (found && found.contextWindow) {
        return found.contextWindow;
      }
    } catch (_) {
      // ignore and fall back
    }
    return this._estimateContextWindow(modelId);
  }

  /**
   * Builds the list of thinking mode options for the UI.
   *
   * Uses model.opencode.variants (Kilo Code API) as primary source.
   * Each variant contains the complete reasoning object (ex: { enabled: true, effort: "high" }).
   * The stored value is the reasoning configuration JSON of the variant.
   *
   * Fallback: if opencode.variants does not exist, try reasoning.supportedEfforts
   * (OpenRouter-style) ou reasoning_effort em supported_parameters.
   *
   * @param {Object} model - Modelo cru da API
   * @returns {Array<{label: string, value: string}>|undefined}
   * @private
   */
  _buildThinkingModes(model) {
    const variants = model.opencode?.variants;
    if (variants) {
      return [
        { label: 'Default', value: '' },
        ...Object.entries(variants).map(([key, variant]) => ({
          label: key.charAt(0).toUpperCase() + key.slice(1),
          value: JSON.stringify(variant.reasoning || {}),
        })),
      ];
    }

    const supportedParameters = Array.isArray(model.supported_parameters)
      ? model.supported_parameters.map(item => String(item).toLowerCase())
      : [];
    const reasoningParams = supportedParameters.filter(param =>
      param === 'reasoning_effort' || param === 'reasoning'
    );
    if (reasoningParams.length === 0) return undefined;

    const reasoningInfo = model.reasoning;
    const efforts = reasoningInfo?.supported_efforts?.length
      ? reasoningInfo.supported_efforts.map(e => String(e))
      : ['none', 'low', 'medium', 'high', 'xhigh'];

    const labels = {
      none: 'None',
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'X-High',
    };

    return [
      { label: 'Default', value: '' },
      ...efforts.map(e => ({
        label: labels[e] || e.charAt(0).toUpperCase() + e.slice(1),
        value: e,
      })),
    ];
  }

  /**
   * Fecha/liberta recursos do cliente.
   */
  close() {
    // OpenAI client does not have a specific close method, but we keep it for consistency
    if (this.openai) {
      // No specific cleanup needed for the OpenAI client
    }
  }

  // ── Private Methods ──────────────────────────────────────────────────────

  /**
   * Applies the reasoning/thinking configuration to requestParams.
   *
   * Aceita:
   * - string: "high"  -> { reasoning_effort: "high" } (OpenAI-style)
   * - objecto: { enabled, effort, maxTokens, exclude } -> { reasoning: {...} } (OpenRouter-style)
   *
   * Format compatible with OpenRouter (used by Kilo Code).
   * @private
   */
  _applyReasoningToRequest(requestParams, reasoning) {
    if (!reasoning) {
      console.log('[AiClient] reasoning: (none — default)');
      return;
    }

    // Caso 1: string simples -> reasoning_effort (OpenAI-style)
    if (typeof reasoning === 'string') {
      const effort = reasoning.trim().toLowerCase();
      if (effort && effort !== 'none' && effort !== 'off' && effort !== 'false') {
        requestParams.reasoning_effort = effort;
        console.log(`[AiClient] reasoning: reasoning_effort=${effort}`);
      } else {
        console.log(`[AiClient] reasoning: (effort "${effort}" — disabled)`);
      }
      return;
    }

    // Caso 2: objecto completo -> reasoning (OpenRouter-style)
    if (typeof reasoning === 'object' && reasoning !== null) {
      console.log(`[AiClient] reasoning: reasoning=${JSON.stringify(reasoning)}`);
      const reasoningParams = {};

      if (reasoning.enabled !== undefined) {
        reasoningParams.enabled = reasoning.enabled;
      }

      if (reasoning.effort) {
        reasoningParams.effort = reasoning.effort;
      }

      if (reasoning.maxTokens !== undefined) {
        reasoningParams.max_tokens = reasoning.maxTokens;
      }

      if (reasoning.exclude !== undefined) {
        reasoningParams.exclude = reasoning.exclude;
      }

      // If there are no valid fields, do not send anything
      if (Object.keys(reasoningParams).length === 0) {
        return;
      }

      requestParams.reasoning = reasoningParams;
    }
  }

  /**
   * Normaliza resposta do LLM para formato consistente.
   * @private
   */
  _normalizeChatResponse(response) {
    if (response?.error) {
      return {
        content: null,
        toolCalls: null,
        finishReason: null,
        usage: null,
        responseModel: null,
        rawResponse: response,
        error: response.error,
      };
    }

    if (!response || !response.choices || response.choices.length === 0) {
      throw new Error('Invalid response from LLM: no choices');
    }

    const choice = response.choices[0];
    const message = choice.message || {};

    return {
      content: message.content || null,
      toolCalls: message.tool_calls || null,
      finishReason: choice.finish_reason || null,
      usage: this._normalizeUsage(response.usage),
      responseModel: response.model || null,
      rawResponse: response,
    };
  }

  /**
   * Normalises a provider usage block into the shape used across the app.
   *
   * Handles both the OpenAI-compatible layout (`prompt_tokens`,
   * `prompt_tokens_details.cached_tokens`) and the Anthropic-style layout
   * (`input_tokens`, `cache_read_input_tokens`), where the cache counters are
   * NOT included in the prompt total.
   *
   * @param {object|null} usage
   * @returns {{promptTokens: number|null, completionTokens: number|null, cacheReadTokens: number, cacheWriteTokens: number, cacheIncludedInPrompt: boolean, totalTokens: number|null}|null}
   * @private
   */
  _normalizeUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;

    const promptTokens = usage.prompt_tokens != null
      ? Number(usage.prompt_tokens)
      : (usage.input_tokens != null ? Number(usage.input_tokens) : null);
    const completionTokens = usage.completion_tokens != null
      ? Number(usage.completion_tokens)
      : (usage.output_tokens != null ? Number(usage.output_tokens) : null);

    const detailsCached = usage.prompt_tokens_details?.cached_tokens != null
      ? usage.prompt_tokens_details.cached_tokens
      : usage.input_tokens_details?.cached_tokens;

    let cacheReadTokens = 0;
    // OpenAI-compatible APIs report cached tokens *inside* prompt_tokens;
    // Anthropic-style APIs report them separately (already excluded from the total).
    let cacheIncludedInPrompt = true;

    if (detailsCached != null) {
      cacheReadTokens = Number(detailsCached) || 0;
      cacheIncludedInPrompt = true;
    } else if (usage.cache_read_input_tokens != null) {
      cacheReadTokens = Number(usage.cache_read_input_tokens) || 0;
      cacheIncludedInPrompt = false;
    }

    const cacheWriteTokens = usage.cache_creation_input_tokens != null
      ? Number(usage.cache_creation_input_tokens)
      : (usage.cache_write_tokens != null ? Number(usage.cache_write_tokens) : 0);

    return {
      promptTokens: Number.isFinite(promptTokens) ? promptTokens : null,
      completionTokens: Number.isFinite(completionTokens) ? completionTokens : null,
      cacheReadTokens: Number.isFinite(cacheReadTokens) ? cacheReadTokens : 0,
      cacheWriteTokens: Number.isFinite(cacheWriteTokens) ? cacheWriteTokens : 0,
      cacheIncludedInPrompt,
      totalTokens: usage.total_tokens != null ? Number(usage.total_tokens) : null,
    };
  }

  /**
   * Detects a provider rejecting the `stream_options` request field.
   * @private
   */
  _isUnsupportedStreamOptions(error) {
    if (!error) return false;
    const status = error?.status ?? error?.response?.status;
    if (status !== 400 && status !== 422) return false;
    const message = String(error?.error?.message || error?.message || '');
    return /stream_options/i.test(message);
  }

  /**
   * Estima tamanho da janela de contexto baseado no nome do modelo.
   * @private
   */
  _estimateContextWindow(modelId) {
    const model = modelId.toLowerCase();

    if (model.includes('gpt-4o') || model.includes('gpt-4-turbo')) return 128000;
    if (model.includes('gpt-4-32k')) return 32768;
    if (model.includes('gpt-4')) return 8192;
    if (model.includes('gpt-3.5-turbo-16k')) return 16385;
    if (model.includes('gpt-3.5-turbo')) return 4096;

    return 32768; // Sensible modern default when provider doesn't specify
  }

  /**
   * Builds structured error.
   * @private
   */
  _buildStructuredError(error) {
    const structured = {
      message: error?.error?.message || error?.message || 'Unknown error',
      status: error?.status || null,
      code: error?.code || null,
      type: error?.type || null,
      error_message: error?.error?.message || null,
    };

    // Preservar metadata dos providers
    if (error?.error?.metadata) {
      structured.metadata = error.error.metadata;
    }

    // Para erros OpenAI nested
    if (error.message && typeof error.message === 'object') {
      const msg = error.message;
      structured.message = msg.error ? msg.error.message : JSON.stringify(msg);
      if (msg.error?.metadata) {
        structured.metadata = msg.error.metadata;
      }
    }

    return structured;
  }

  /**
   * Checks if it is an abort error.
   *
   * Besides native errors (AbortError/ABORT_ERR/499), the OpenAI SDK v6
   * atira `APIUserAbortError` (subclasse de APIError com status undefined)
   * when the request is cancelled via AbortSignal. Not exported in a stable
   * way for `instanceof`, so we detect by constructor name
   * ou por status undefined + mensagem contendo "abort".
   * @private
   */
  _isAbortError(error) {
    if (!error) return false;
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || error?.status === 499) return true;
    if (error?.code === 'ECONNABORTED') return true;
    if (error?.constructor?.name === 'APIUserAbortError') return true;
    if (error?.status === undefined && error instanceof Error) {
      const msg = String(error?.message || '');
      return /abort/i.test(msg);
    }
    return false;
  }

  /**
   * Processa o stream do OpenAI e chama callback com chunks normalizados.
   *
   * The `finish` event is emitted **once**, after the stream ends, so a usage block
   * arriving in a trailing chunk (OpenAI's `stream_options.include_usage` behaviour)
   * is still attached to it. Providers that put `usage` in the `finish_reason` chunk
   * (Kilo does) keep working unchanged.
   *
   * @private
   */
  async _processStream(stream, onChunk, abortSignal) {
    const toolCallsBuffer = new Map(); // To accumulate tool calls coming in multiple chunks

    let finishReason = null;
    let usage = null;
    let responseModel = null;

    try {
      for await (const chunk of stream) {
        // Verificar abort a cada chunk
        if (abortSignal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }

        // Usage can arrive in ANY chunk: the finish_reason chunk (Kilo) or a
        // trailing chunk after it (OpenAI-compatible providers).
        if (chunk?.usage) {
          const normalized = this._normalizeUsage(chunk.usage);
          if (normalized) usage = normalized;
        }
        if (chunk?.model && !responseModel) {
          responseModel = chunk.model;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (!delta) continue;

        // Process content delta
        if (delta.content) {
          onChunk({
            type: 'delta',
            content: delta.content,
          });
        }

        // Processar tool calls
        if (delta.tool_calls) {
          for (const toolCallDelta of delta.tool_calls) {
            const index = toolCallDelta.index;
            if (index === undefined) continue;

            // Initialize tool call if it does not exist
            if (!toolCallsBuffer.has(index)) {
              toolCallsBuffer.set(index, {
                id: null,
                type: toolCallDelta.type || 'function',
                function: { name: null, arguments: '' },
              });

              // Send tool call start event
              onChunk({
                type: 'tool_call_start',
                toolCallId: `call_${index}`, // Placeholder, will be updated
                function: { name: null, arguments: '' },
              });
            }

            const toolCall = toolCallsBuffer.get(index);

            // Atualizar ID e tipo da tool call
            if (toolCallDelta.id) {
              toolCall.id = toolCallDelta.id;
              if (toolCallDelta.type) {
                toolCall.type = toolCallDelta.type;
              }
              onChunk({
                type: 'tool_call_start',
                toolCallId: toolCall.id,
                function: { ...toolCall.function },
              });
            }

            // Update function name
            if (toolCallDelta.function?.name) {
              toolCall.function.name = toolCallDelta.function.name;
              onChunk({
                type: 'tool_call_delta',
                toolCallId: toolCall.id || `call_${index}`,
                arguments: toolCall.function.arguments,
              });
            }

            // Acumular argumentos
            if (toolCallDelta.function?.arguments) {
              toolCall.function.arguments += toolCallDelta.function.arguments;
              onChunk({
                type: 'tool_call_delta',
                toolCallId: toolCall.id || `call_${index}`,
                arguments: toolCall.function.arguments,
              });
            }
          }
        }

        // Verificar finish reason (NÃO interrompe o stream: o usage pode vir depois)
        const reason = choice?.finish_reason;
        if (reason && !finishReason) {
          finishReason = reason;

          // Finalizar tool calls pendentes
          for (const [index, toolCall] of toolCallsBuffer) {
            onChunk({
              type: 'tool_call_end',
              toolCallId: toolCall.id || `call_${index}`,
            });
          }
        }
      }
    } catch (error) {
      if (abortSignal?.aborted || this._isAbortError(error)) {
        throw error;
      }

      const structuredError = this._buildStructuredError(error);
      onChunk({
        type: 'error',
        error: structuredError,
      });
      throw error;
    }

    // Evento de finish emitido uma única vez, já com o usage (seja o do chunk de
    // finish_reason, seja o de um chunk final posterior).
    if (finishReason || usage) {
      const finalToolCalls = Array.from(toolCallsBuffer.values()).map(tc => ({
        id: tc.id,
        type: 'function',
        function: { ...tc.function },
      }));
      onChunk({
        type: 'finish',
        finishReason: finishReason || null,
        usage,
        responseModel,
        toolCalls: finalToolCalls,
      });
    }
  }
}

module.exports = { AiClient };