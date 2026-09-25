/**
 * @typedef {Object} AiClientConfig
 * @property {string} [apiKey] - Chave da API do provider (opcional para providers locais)
 * @property {string} baseUrl - URL base do endpoint do provider
 * @property {string} [model] - Modelo default (opcional)
 * @property {number} [timeout=600000] - Timeout em ms (10 minutos por default)
 * @property {number} [maxRetries=3] - Maximum number of retries on rate-limit
 */

/**
 * Reasoning/thinking configuration of a model.
 * Format compatible with the OpenRouter `reasoning` object (used by Kilo Code).
 *
 * @typedef {Object} ReasoningConfig
 * @property {boolean} [enabled] - If reasoning is active
 * @property {string} [effort] - Effort level ("xhigh" | "high" | "medium" | "low" | "minimal" | "none" | outros por modelo)
 * @property {number} [maxTokens] - Maximum reasoning tokens
 * @property {boolean} [exclude] - If reasoning should be excluded from the response
 */

/**
 * @typedef {Object} ChatCompletionRequest
 * @property {string} model - Modelo a usar
 * @property {Array} messages - Array de mensagens [{role, content}]
 * @property {Array} [tools] - Available tools (optional)
 * @property {number} [maxTokens] - Maximum tokens in response
 * @property {AbortSignal} [signal] - Sinal para cancelamento (opcional)
 * @property {ReasoningConfig|string} [reasoning] - Reasoning/thinking configuration.
 *   Pode ser uma string simples (ex: "high") enviada como `reasoning_effort`,
 *   ou um objeto completo (ex: { enabled: true, effort: "high", maxTokens: 8000 }).
 */

/**
 * @typedef {Object} ChatCompletionResponse
 * @property {string|null} content - Texto gerado pela AI
 * @property {Array|null} toolCalls - Chamadas de ferramentas (se houver)
 * @property {string|null} finishReason - Motivo de fim ("stop", "length", "tool_calls", "content_filter", null)
 * @property {Object|null} usage - Usage statistics {promptTokens, completionTokens}
 * @property {Object} rawResponse - Resposta crua do provider
 */

/**
 * @typedef {Object} StreamingChunk
 * @property {'delta'|'tool_call_start'|'tool_call_delta'|'tool_call_end'|'finish'|'error'} type - Tipo do chunk
 * @property {string} [content] - Texto para delta
 * @property {string} [toolCallId] - ID da tool call (para tool_call_*)
 * @property {Object} [function] - Tool call function (for tool_call_start)
 * @property {string} [arguments] - Argumentos da tool call (para tool_call_delta)
 * @property {string} [finishReason] - Motivo de fim (para finish)
 * @property {Object} [usage] - Statistics (for finish)
 * @property {Object} [error] - Erro estruturado (para error)
 */

/**
 * Reasoning information supported by a model.
 * Corresponds to the `reasoning` object that OpenRouter exposes per model.
 *
 * @typedef {Object} ReasoningInfo
 * @property {boolean} [mandatory] - If reasoning is mandatory for this model
 * @property {boolean} [defaultEnabled] - If reasoning is active por default
 * @property {string[]} [supportedEfforts] - Supported effort levels (ex: ["low", "medium", "high"])
 * @property {string} [defaultEffort] - Effort level default
 */

/**
 * @typedef {Object} ModelInfo
 * @property {string} id - ID do modelo
 * @property {string} name - Friendly model name
 * @property {number} contextWindow - Tamanho da janela de contexto
 * @property {boolean} [supportsReasoning] - Indicates whether the provider supports external reasoning mode
 * @property {string[]} [reasoningParameters] - Reasoning parameters supported by the provider
 * @property {boolean} [hasInternalReasoning] - Indicates whether the provider supports internal reasoning by default
 * @property {ReasoningInfo} [reasoning] - Model-specific reasoning information (OpenRouter-style)
 * @property {Array<{label: string, value: string}>} [thinkingModes] - Thinking mode options for the UI.
 *   Derivado de reasoning.supportedEfforts ou do conjunto default de reasoning_effort.
 *   Cada entrada tem { label: "None", value: "none" }.
 */

module.exports = {};