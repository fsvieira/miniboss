const fs = require('fs');
const path = require('path');
const { createTools } = require('../tools');
const { AiClient } = require('../services/ai');
const { STATIC_PROTOCOL_PROMPT, buildLightState } = require('../services/context/lightContext');
const { countMessageTokens, getTokenLimit } = require('./tokenController');
const socketService = require('../services/socketService');
const { filterMessagesForLLM, normalizeMessagesForLLM } = require('../utils/messageFilter');
const { loadProtocol } = require('../services/protocol');
const { FOCUS_PHASE } = require('../constants/focusProtocol');
const logger = require('../utils/logger');
const { stateLogger } = logger;

// ===== FOCUS SYSTEM PROMPTS =====

const MAIN_PLAN_PROMPT = `# Mini-Boss MAIN Agent — Plan Mode (read-only)

You are the MAIN agent for Mini-Boss in **PLAN MODE**. Your work is read-only: you explore, analyze, and produce a plan — you do NOT modify files or run commands. All write tools are disabled in this mode.

---

## Operating Loop

At every iteration answer: **"What is the single smallest step or decision that must resolve now so the project can advance?"**

1. Inspect the latest state (read files, search, investigate).
2. Understand the user's objective and the current codebase.
3. Build or refine a concrete plan. Use \`updatePlan\` to store the plan (goal, steps, acceptance criteria) — one current plan per conversation.
4. Break the work into a TODO tree with \`addTodo\`/\`updateTodo\`/\`removeTodo\` — use todos whenever the work has multiple steps or a clear order.
5. Use \`investigate\` to spawn a read-only sub-agent for blocking uncertainties or evidence gathering.

You think in decisions, not plans of action you can execute right now.

---

## Rules of Plan Mode

* **Never** call \`writeFile\`, \`editFile\`, \`moveFile\`, \`deleteFile\`, \`createDirectory\`, \`copyFile\`, or \`runCommand\` — they are disabled in plan mode.
* Do not attempt to execute the plan. Your job is to prepare it.
* Prefer \`updatePlan\` over long chat messages when you have a concrete plan to communicate.
* Keep the plan concise and actionable; update the TODO tree as the plan evolves.
* When the plan is ready, tell the user to switch to Exec Mode to start executing.

---

## What a Valid Plan Looks Like

* One clear objective tied to the user's request.
* Ordered steps, each atomic and verifiable.
* Explicit acceptance criteria for completion.
* Mapped to the TODO tree so progress can be tracked during execution.

`;

const MAIN_PROMPT = `# Mini-Boss MAIN Agent — Exec Mode

You are the MAIN agent for Mini-Boss in **EXEC MODE**. You execute the current plan directly in the project worktree — you read, write, edit files and run commands — while keeping the global objective aligned. When a blocking uncertainty or isolated investigation is needed, you delegate a read-only investigation to a sub-agent via \`investigate\`.

---

## Operating Loop

At every iteration answer: **"What is the single smallest action that must resolve now so the project can advance?"**

1. Load the current plan with \`getPlan\` and the TODO tree with \`getTaskTree\`.
2. Mark the next task \`in_progress\` with \`updateTodo\`, execute the step, then mark it \`done\`.
3. Execute the next technical step directly (edit/write/command).
4. Decide whether the MAIN must:
   - execute the next step directly,
   - spawn one read-only investigation (\`investigate\`) to resolve a blocking uncertainty or gather evidence,
   - request clarification from the user,
   - or conclude the task.
5. If the plan needs adjusting while executing, update it with \`updatePlan\`.

---

## TODO Discipline

* **Always keep todos updated**: mark a task \`in_progress\` when you start it and \`done\` when you finish it.
* Add missing subtasks with \`addTodo\` when execution reveals them.
* Remove completed or obsolete todos with \`removeTodo\`.

---

## What a Valid Investigation Looks Like

* One atomic objective tied to the current blocker.
* Exactly one logical step.
* Produces a minimal, inspectable deliverable or concrete answer.
* Can be completed without parallel work.

Invalid investigations bundle multiple phases, combine discovery + implementation, or attempt broad features.

---

## Investigation Checklist

When you call \`investigate\`, populate:

* **Goal** – a single-sentence atomic objective.
* **Context** – only the facts needed to start immediately.
* **Expected Result** – the smallest deliverable that lets you choose the next move.

Within your reasoning confirm:

1. Why this investigation is the critical next step.
2. What minimal deliverable you expect.
3. What guardrails must not be crossed.

If any prerequisite is missing, request clarification instead of delegating.

---

## Handling Investigation Reports

Investigation sub-agents are read-only and return markdown reports with the sections:

1. **Summary** – one paragraph outcome.
2. **Work Performed** – concrete actions/files inspected.
3. **Outstanding / Risks** – unresolved items, blockers, uncertainties.
4. **Handoff Notes** – guidance for the parent about next decisions.

When a report arrives:

* Assimilate it into the global picture.
* Decide explicitly: execute the next step yourself, spawn another investigation, ask for clarification, or conclude.
* Do not relaunch the same work or expand scope without a new decision.

---

## Rules of Engagement

* Only one investigation may exist at a time per branch of the tree.
* \`investigate\` sub-agents are read-only — they cannot modify the repository; all writes must be done by you.
* Maintain awareness of every active investigation and wait for the report before moving on.
* Guard the global objective while forcing precise, minimal execution steps.
* Update the plan and TODO tree as you progress.
`;

const FOCUS_PROMPT = `# Mini-Boss Investigation Subbot

You are a READ-ONLY investigation subbot. You gather evidence, analyze, and answer the assigned question for the parent agent. You never modify the repository: all file edits and writes are done by the parent MAIN agent. The sandbox enforces read-only on the worktree.

---

## Kickoff Discipline

1. Parse the assigned goal, context, guardrails, and expected result from the metadata.
2. Validate that the investigation is atomic. If it is broader than one step, explicitly narrow to the first critical question and note any leftover work in the final report.
3. Confirm prerequisites. If missing information blocks you, request clarification from the parent instead of improvising.

---

## Execution Guardrails

* Prioritize inspection, analysis, and measurement. You are read-only — use readFile, search, grep, and runCommand (read-only sandbox) to investigate.
* Only inspect files or systems necessary for the minimal deliverable.
* Track every tool you invoke — excessive reads without progress require you to pause and reassess.

---

## Sub-Investigation Decision Guidance

When progress is blocked, choose exactly one path:

1. Continue this investigation if the blocker can be resolved in one small, atomic read-only action within scope.
2. Create one sub-investigation if resolution requires new dedicated read-only work and this investigation must wait.
3. Report completion or partial completion if this investigation has done everything it can without expanding scope.

If the work can continue without a sub-investigation, do not create one. If you create a sub-investigation, do not continue tool work in this turn; wait for that report before resuming.

---

## Report Template (Mandatory)

When you conclude, call \`submitFindings\` with markdown containing **all** sections below in this order:

1. **Summary** – one paragraph stating the outcome and whether the expected result was achieved.
2. **Work Performed** – bullet list of concrete actions, files inspected, commands run, evidence gathered.
3. **Outstanding / Risks** – unresolved items, blockers, uncertainties, or debt to highlight.
4. **Handoff Notes** – guidance for the parent on what decision should come next (e.g., new investigation suggestion, implementation recommendation, or waiting for user).

Use \`completed=true\` only when the expected result is fully achieved. Otherwise pass \`completed=false\` and clearly call out what remains in **Outstanding / Risks**.

After the report is sent, you must stop. Do not queue additional tool calls or reasoning.

---

## Non-Negotiable Rules

* Stay inside the assigned scope at all times.
* Do not continue beyond the first critical step, even if follow-up feels obvious.
* Only one sub-investigation may exist at a time and only to clear a blocking uncertainty.
* \`submitFindings\` is always your final action. If the parent requests further work, wait for a new investigation.
`;

const FOCUS_REPORT_ONLY_PROMPT = `# Mini-Boss Investigation Report Required

The investigation phase has ended because it reached its iteration budget or stopped without submitting a report.

Your only task now is to submit the final handoff report to the parent.

You MUST call \`submitFindings\` as your only tool call.

Do not run commands, inspect files, create sub-investigations, or continue analysis.

If the assigned work is incomplete, call \`submitFindings\` with \`completed=false\` and clearly describe the partial state.

The report markdown MUST contain these sections in this order:

1. **Summary** – outcome and whether the expected result was achieved.
2. **Work Performed** – concrete actions, files inspected, commands run, evidence gathered.
3. **Outstanding / Risks** – unresolved items, blockers, uncertainties, or debt.
4. **Handoff Notes** – guidance for the parent about the next decision.
`;

const PROJECT_MEMORY_PROMPT = `# Mini-Boss Project Memory

You are the persistent memory of the project. The user converses freely here — ideas, doubts, decisions, discoveries — and you keep structured knowledge in SQLite (project notes).

---

## Operating Principles

* You work **read-only** over the project folder (the sandbox is read-only). You never edit files, copy files, create directories, or commit. You only inspect and run read-only commands (tests, builds, lint, git status).
* You are **not** a Kanban and not a task manager. The flow is non-linear: capture and connect knowledge, not tickets.
* Keep responses concise and grounded in what the user said and what the project memory shows.

## Knowledge Discipline

* Maintain structured knowledge with \`saveNote\` / \`updateNote\`.
* **Before saving**, use \`searchNotes\` / \`listNotes\`: if a related note exists, **update** it instead of creating a duplicate.
* \`kind\` is one of: \`idea\` | \`note\` | \`decision\` | \`discovery\` | \`open_question\`.
* Record the **why / reasoning**, not only the conclusion.
* Archive notes that are no longer relevant (\`status="archived"\`) instead of deleting them.
* When something old becomes relevant again, connect it to the existing note.
* The user may also explicitly ask you to save something — honour that.

## Plans and Execution

* When the user decides to implement something, produce a plan with \`updatePlan\` (goal, ordered steps, acceptance criteria) and tell the user to press **Executar**.
* **You do not execute the plan.** Execution happens in a separate implementation conversation.
* The current state includes a \`projectMemory\` block: active notes, active executions, a compact map of the project's conversations (\`conversations\`) and \`untracked\`. Use it to know what is in flight and to answer "Onde estava?" (where were we?) with a recap of focus, recent decisions, discoveries, related ideas, in-flight executions, and next steps.

## Project overview

* Use \`listProjectConversations\` for a deterministic map of the project's conversations (no AI cost). It returns derived \`status\`, \`linkedToExecution\`/\`executionStatus\`, and \`untracked\` roots (conversations with no recorded plan execution). Prefer this for structural questions ("which conversations exist?", "what has no task registered?").
* Use \`requestConversationReport\` to get an AI status report for **one** conversation (objective, done, in progress, blockers/risks, next steps). It costs one AI call, reads the target read-only, and writes nothing to it. Call it only when the user needs a narrative of a specific conversation; use \`listProjectConversations\` first to pick the id.
* Always surface conversations reported as \`untracked\` (or \`linkedToExecution: false\` roots) to the user — those are project conversations without a recorded execution/task.
* The report's \`meta.processingState\` reflects a point-in-time snapshot: if the target is still processing, the report may capture a mid-turn state. Mention this caveat when it applies. A focus conversation that already has a stored report returns it without a new AI call.
`;

async function sendToAI({
  targetProvider, targetModel, 
  sourceMessages, workingDir, 
  maxIterations,
  customInstructions = '', 
  conversationId = null, 
  conversation = null,
  db = null,
  sendEvent = null,
  signal = null,
  isFinalizing = false  // <-- nova flag, passada pelo ConversationManager
}) {
  // Determine conversation type for tool selection
  let conversationType = 'chat';
  if (conversation && conversation.conversation_type) {
    conversationType = conversation.conversation_type;
  } else if (conversationId && db) {
    try {
      const conv = db.getConversation(conversationId);
      if (conv && conv.conversation_type) {
        conversationType = conv.conversation_type;
      }
    } catch (_) {}
  }

  // Select tools based on conversation type
  // Pass the db instance to avoid race conditions from separate DB connections
  // The project conversation wants memory tools even without workingDir (project without folder).
  const tools = (workingDir || conversationType === 'project') ? createTools(workingDir, conversationId, conversationType, db) : null;
  const isMain = conversationType === 'main';
  const isFinalTurn = !isMain && maxIterations === 0;
  let effectiveTools = tools;

  // Filter tools for focus conversations based on phase
  if (conversationType === 'focus' && Array.isArray(tools)) {
    if (isFinalizing || isFinalTurn) {
      // Finalizing/Report-only: only submitFindings available
      effectiveTools = tools.filter(t => t?.function?.name === 'submitFindings');
    }
    // If not in finalizing, uses all tools (already filtered by createTools)
  }

  // === SIMPLE CONTEXT STRATEGY ===
  // - Full recent user + assistant dialogue (last ~6 responses)
  // - Only the last 6 tool results
  // - Drop very short assistant messages unless they have tool_calls
  // - Inject a tiny structured state (tasks + objective + system info)
  //
  // This is the only thing sent to the LLM. No more giant context packs.

  const lightState = buildLightState({
    db,
    conversation,
    provider: targetProvider,
    targetModel,
    messages: sourceMessages,
    workingDir,
    maxIterations,
    customInstructions,
    effectiveTools,
  });

  // For focus conversations, exclude stored system messages from history
  // to avoid duplicating the goal/context (already injected via focusGoalContext above).
  const filteredHistory = filterMessagesForLLM(sourceMessages, {
    lastNResponses: 100,
    minAssistantLength: 150,
    excludeSystem: conversationType === 'focus',
  });

  const normalizedHistory = normalizeMessagesForLLM(filteredHistory);

  const stateForLLM = {
    tasks: lightState.tasks || {},
    system: lightState.system || {},
    current_objective: lightState.current_objective || {},
  };

  // Projects: inject projectMemory block (active notes + active executions)
  if (lightState.projectMemory) {
    stateForLLM.projectMemory = lightState.projectMemory;
  }

  const lightStateMessage = {
    role: 'system',
    content: '[Current state]\n' + JSON.stringify(stateForLLM),
  };

  // Log system prompt selection before the selection logic
  stateLogger.stateTransition('prompt_selection', 'pre-selection', {
    conversationId,
    conversationType,
    phase: isFinalTurn ? 'finalization' : 'execution',
  });

  // Select the appropriate system prompt based on conversation type
  let systemPrompt = STATIC_PROTOCOL_PROMPT;
  if (conversationType === 'main') {
    const isPlanMode = conversation?.mode === 'plan';
    systemPrompt = isPlanMode ? MAIN_PLAN_PROMPT : MAIN_PROMPT;
    logger.debug(`[sendToAI] System prompt selected: conversationType=${conversationType}, mode=${isPlanMode ? 'plan' : 'exec'}, phase=${isFinalTurn ? 'finalization' : 'execution'}, promptType=${isPlanMode ? 'MAIN_PLAN_PROMPT' : 'MAIN_PROMPT'}`);
  } else if (conversationType === 'focus') {
    // Inject focus goal into the FOCUS prompt if available
    let focusGoalContext = '';
    let goal = null;
    if (conversation && conversation.focus_goal) {
      try {
        goal = JSON.parse(conversation.focus_goal);
        const firstStep = goal.firstStep || goal.first_action || '';
        const minimalDeliverable = goal.minimumDeliverable || goal.expectedResult || '';
        const guardrails = goal.guardrails || '';
        const contextSection = [`### Context`, goal.context || 'See conversation history.'];
        if (goal.finalizing) {
          contextSection.push(
            '',
            '## FINALIZATION PHASE',
            'This investigation is ending. Your ONLY available tool is `submitFindings`.',
            'You MUST call `submitFindings` now with a markdown report.',
            'If the work is incomplete, use `completed: false` and provide a partial report (Summary, Work Performed, Outstanding / Risks, Handoff Notes).',
            'Do not attempt any other action — do not create sub-investigations, do not run additional tools.'
          );
        }
        focusGoalContext = [
          '',
          '## ASSIGNED FOCUS',
          `Goal: ${goal.goal || '(missing)'}`,
          firstStep ? `First Critical Step: ${firstStep}` : 'First Critical Step: Identify the first actionable move before executing.',
          minimalDeliverable ? `Expected Minimal Deliverable: ${minimalDeliverable}` : '',
          guardrails ? `Guardrails: ${guardrails}` : '',
          '',
          ...contextSection
        ].filter(Boolean).join('\n');
      } catch (_) {}
    }
    // Log focus creation with system prompt selection
    // isFinalizing is passed as parameter by ConversationManager
    const useReportOnly = isFinalTurn || isFinalizing;
    if (useReportOnly) {
      stateLogger.focusFinalizing(conversationId, 'FOCUS_REPORT_ONLY_PROMPT');
    } else {
      stateLogger.focusCreated(conversationId, 'FOCUS_PROMPT', goal?.goal || '');
    }
    systemPrompt = (useReportOnly ? FOCUS_REPORT_ONLY_PROMPT : FOCUS_PROMPT) + focusGoalContext;
    logger.debug(`[sendToAI] System prompt selected: conversationType=${conversationType}, phase=${useReportOnly ? 'finalization' : 'execution'}, promptType=${useReportOnly ? 'FOCUS_REPORT_ONLY_PROMPT' : 'FOCUS_PROMPT'}`);
    stateLogger.stateTransition('focus_selected', useReportOnly ? 'finalization' : 'execution', {
      conversationId,
      systemPromptType: useReportOnly ? 'FOCUS_REPORT_ONLY_PROMPT' : 'FOCUS_PROMPT',
    });
  } else if (conversationType === 'project') {
    systemPrompt = PROJECT_MEMORY_PROMPT;
    logger.debug(`[sendToAI] System prompt selected: conversationType=${conversationType}, promptType=PROJECT_MEMORY_PROMPT`);
    stateLogger.stateTransition('project_memory_selected', 'execution', {
      conversationId,
      systemPromptType: 'PROJECT_MEMORY_PROMPT',
    });
  }

   // Log the selected system prompt
   const selectedPromptType = systemPrompt.includes('MAIN') ? 'MAIN_PROMPT' :
                              (systemPrompt.includes('FOCUS REPORT REQUIRED') ? 'FOCUS_REPORT_ONLY_PROMPT' :
                              (systemPrompt.includes('Project Memory') ? 'PROJECT_MEMORY_PROMPT' : 'FOCUS_PROMPT'));
   stateLogger.stateTransition('prompt_selected', selectedPromptType, {
     conversationId,
     conversationType,
     phase: isFinalTurn ? 'finalization' : 'execution',
     promptLength: systemPrompt.length,
   });
   
   const toolsSummary = effectiveTools 
     ? effectiveTools.map(t => t?.function?.name).filter(Boolean).join(', ')
     : 'none';
   
   logger.debug(`[sendToAI] Final prompt: ${selectedPromptType} (length: ${systemPrompt.length})`);
   // logger.debug(`[sendToAI] System prompt content:\n${systemPrompt}`);
   // logger.debug(`[sendToAI] Effective tools: ${toolsSummary}`);
   // logger.debug(`[sendToAI] Effective tools detail: ${JSON.stringify(effectiveTools)}`);
    
   // --- Get real token limit from provider ---
   let tokenLimit = getTokenLimit(targetModel) || 32768;
   const lookupClient = new AiClient({
     apiKey: targetProvider.api_key || 'dummy',
     baseUrl: targetProvider.base_url,
     timeout: 10000,
     maxRetries: 1,
   });
   try {
     const fetched = await lookupClient.getModelContextLength(targetModel);
     if (fetched && fetched > 0) {
       tokenLimit = fetched;
     }
   } catch (_) {
     // fallback to hardcoded limit
   }
   lookupClient.close();

   // --- Pre-flight token check ---
   // Estimate total tokens the AI provider will see:
   //   finalMessages + tools definitions + max_tokens
   const finalMessages = [
     { role: 'system', content: systemPrompt },
     lightStateMessage,
     ...normalizedHistory,
   ];

   const finalTokens = countMessageTokens(stripMeta(finalMessages));
   const rawTokens = countMessageTokens(sourceMessages || []);
   const toolsTokens = effectiveTools ? Math.round(JSON.stringify(effectiveTools).length / 3) : 0;
   const outputTokens = 8192;
   const totalEstimated = finalTokens + toolsTokens + outputTokens;

   // If we exceed the token limit, progressively reduce the history
   let finalMessagesToUse = finalMessages;
   if (totalEstimated > tokenLimit) {
     logger.debug(`[sendToAI] Total estimated tokens ${totalEstimated} exceeds limit ${tokenLimit}. Applying compression...`);
     
      // Stage 1: Reduce lastNResponses
      for (let n = 4; n >= 1; n--) {
        const tighterFilter = filterMessagesForLLM(sourceMessages, {
          lastNResponses: n,
          minAssistantLength: 300,
          excludeSystem: conversationType === 'focus',
        });
       const tighterHistory = normalizeMessagesForLLM(tighterFilter);
       const tighterMessages = [
         { role: 'system', content: systemPrompt },
         lightStateMessage,
         ...tighterHistory,
       ];
       const tighterTokens = countMessageTokens(stripMeta(tighterMessages)) + toolsTokens + outputTokens;
       if (tighterTokens <= tokenLimit) {
         finalMessagesToUse = tighterMessages;
         logger.debug(`[sendToAI] Compressed to lastNResponses=${n}: ~${countMessageTokens(stripMeta(tighterMessages))} tokens`);
         logger.debug(`[sendToAI] Compressed system prompt:\n${systemPrompt}`);
         break;
       }
     }

      // Stage 2: If still too large, keep a minimal light state (only the
      // current objective) and only the last 2 responses. Never strip the
      // objective entirely — the model must retain alignment with the goal.
      if (countMessageTokens(stripMeta(finalMessagesToUse)) + toolsTokens + outputTokens > tokenLimit) {
        const minimalFilter = filterMessagesForLLM(sourceMessages, {
          lastNResponses: 2,
          minAssistantLength: 500,
          excludeSystem: conversationType === 'focus',
        });
       const minimalHistory = normalizeMessagesForLLM(minimalFilter);
       const minimalLightStateMessage = {
         role: 'system',
         content: '[Current state]\n' + JSON.stringify({
           current_objective: stateForLLM.current_objective || {},
           system: { conversation_id: stateForLLM.system?.conversation_id },
         }),
       };
       finalMessagesToUse = [
         { role: 'system', content: systemPrompt },
         minimalLightStateMessage,
         ...minimalHistory,
       ];
       const minimalTokens = countMessageTokens(stripMeta(finalMessagesToUse)) + toolsTokens + outputTokens;
       if (minimalTokens > tokenLimit) {
         logger.warn(`[sendToAI] Even minimal context (${minimalTokens} tokens) exceeds limit (${tokenLimit}). Will send anyway — provider may reject.`);
       } else {
         logger.debug(`[sendToAI] Minimal context: ~${countMessageTokens(stripMeta(finalMessagesToUse))} tokens`);
       }
      }
   }

   const guardThreshold = Math.floor(tokenLimit * 0.8);
   const initialContextTokens = countMessageTokens(stripMeta(finalMessagesToUse));
   if (initialContextTokens > guardThreshold) {
     const guardResult = applyContextBudgetGuard(finalMessagesToUse, {
       tokenLimit,
       threshold: guardThreshold,
       countTokens: (messages) => countMessageTokens(stripMeta(messages))
     });
     finalMessagesToUse = guardResult.messages;
     if (guardResult.actions.length > 0) {
       logger.debug(`[sendToAI] Context budget guard replaced ${guardResult.actions.length} tool messages (tokens ~${guardResult.tokenCount}/${tokenLimit}).`);
     }
   }

   writeDebugSnapshot({
     conversationId,
     conversationType,
     phase: isFinalTurn ? 'finalization' : 'execution',
     selectedPromptType,
     systemPrompt,
     effectiveTools,
     toolsSummary,
     finalMessagesToUse,
     tokenLimit,
   });

  // --- Broadcast context info ---
  const effectiveFinalTokens = countMessageTokens(stripMeta(finalMessagesToUse));
  const percentage = Math.round((effectiveFinalTokens / tokenLimit) * 100);

  if (conversationId) {
    const contextInfoPayload = {
      conversationId,
      message_count: (sourceMessages || []).length,
      compressed_message_count: finalMessagesToUse.length,
      input_tokens: rawTokens,
      compressed_tokens: effectiveFinalTokens,
      token_limit: tokenLimit,
      percentage: Math.min(percentage, 100),
      model: targetModel,
      provider_name: targetProvider?.name || null,
      strategy: percentage < 100 ? 'full_dialogue_last_tool_results' : 'compressed',
    };

    // Metrics (Phase D) — same aggregation function as GET /:id/context
    try {
      if (db && conversationId) {
        const usage = db.getConversationTokenUsage(conversationId);
        const subtreeIds = db.getConversationSubtreeIds(conversationId);
        contextInfoPayload.total_tokens = usage.total_tokens;
        contextInfoPayload.total_cost = usage.total_cost_usd;
        contextInfoPayload.models = usage.models;
        contextInfoPayload.subbot_count = Math.max(0, subtreeIds.length - 1);
        contextInfoPayload.focus_level = conversation && conversation.parent_id ? (() => {
          let level = 0;
          let ancestor = conversation;
          while (ancestor && ancestor.parent_id) {
            level++;
            ancestor = db.getConversation(ancestor.parent_id);
          }
          return level;
        })() : 0;
      }
    } catch (_) {}

    try {
      socketService.broadcastToConversation(conversationId, 'context_info', contextInfoPayload);
    } catch (_) {
      // socket may not be ready yet; ignore
    }
  }

  if (conversationId && sendEvent) {
    sendEvent({
      type: 'context_pack_built',
      conversationId,
      diagnostics: {
        sourceMessageCount: (sourceMessages || []).length,
        compressedTokens: effectiveFinalTokens,
      },
      event: lightState.current_objective?.event,
      intent: lightState.current_objective?.intent,
      strategy: percentage < 100 ? 'full_dialogue_last_tool_results' : 'compressed',
    });
  }
  
  const aiClient = new AiClient({
    apiKey: targetProvider.api_key || 'dummy',
    baseUrl: targetProvider.base_url,
    timeout: 600000,
    maxRetries: 3,
  });

  const finalMessagesForSend = stripMeta(finalMessagesToUse);

  // Extract thinking/reasoning configuration from conversation
  // thinking_mode pode ser:
  //   - string simples: "high" | "none" | "low" | ...
  //   - JSON: {"enabled": true, "effort": "high"} | {"effort": "max"} | ...
  // Fallback: if the conversation does not have its own thinking, uses the global default (settings).
  let thinkingValue = conversation?.thinking_mode;
  if (!thinkingValue && db && typeof db.getSetting === 'function') {
    try {
      thinkingValue = db.getSetting('default_thinking_mode') || null;
    } catch (_) {}
  }
  const reasoning = parseThinkingMode(thinkingValue);

  const toolCallsList = [];
  let accumulatedContent = '';
  let finishReason = null;
  let usage = null;

  try {
    await aiClient.chatCompletionStream(
      {
        model: targetModel,
        messages: finalMessagesForSend,
        tools: effectiveTools,
        maxTokens: 8192,
        signal,
        reasoning,
      },
      (chunk) => {
        if (chunk.type === 'delta' && chunk.content) {
          accumulatedContent += chunk.content;
          if (conversationId) {
            socketService.broadcastText(conversationId, chunk.content);
          }
        } else if (chunk.type === 'finish') {
          finishReason = chunk.finishReason;
          usage = chunk.usage;
          if (chunk.toolCalls && chunk.toolCalls.length > 0) {
            toolCallsList.push(...chunk.toolCalls);
          }
        }
      }
    );
  } catch (err) {
    throw err;
  }

  const content = accumulatedContent || null;
  const toolCalls = toolCallsList.length > 0 ? toolCallsList : null;

  return {
    content,
    toolCalls,
    finishReason: finishReason || null,
    usage: usage ? {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    } : null,
    rawResponse: {
      choices: [{
        message: {
          content: content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason || 'stop',
      }],
      usage: usage ? {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
      } : null,
    },
  };
}

/**
 * Converts the conversation thinking_mode into reasoning configuration
 * compatible with AiClient / OpenRouter.
 *
 * Aceita:
 *   - null/undefined/empty -> undefined (do not send anything)
 *   - string simples: "high", "none", "low" -> "high" (enviado como reasoning_effort)
 *   - JSON string: '{"effort": "high"}' ou '{"enabled": true, "maxTokens": 8000}' -> objeto
 *   - objecto: { effort: "high" } -> passado diretamente
 *
 * @param {string|Object|null|undefined} thinkingMode
 * @returns {string|Object|undefined}
 */
function parseThinkingMode(thinkingMode) {
  if (thinkingMode == null || thinkingMode === '' || thinkingMode === 'null') {
    return undefined;
  }

  // Already is object
  if (typeof thinkingMode === 'object') {
    return thinkingMode;
  }

  // Simple string (does not look like JSON)
  if (typeof thinkingMode === 'string' && !thinkingMode.trim().startsWith('{')) {
    return thinkingMode.trim();
  }

  // Tentar parsear JSON
  try {
    return JSON.parse(thinkingMode);
  } catch (_) {
    // If not valid JSON, use as simple string
    return thinkingMode.trim();
  }
}

module.exports = {
  buildSystemPrompt: () => STATIC_PROTOCOL_PROMPT,
  sendToAI
};

function stripMeta(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    const { __meta, ...rest } = msg;
    return rest;
  });
}

function buildToolPlaceholder(message) {
  const meta = message?.__meta || {};
  const toolName = meta.toolName || 'tool';
  const primaryPath = meta.path || (Array.isArray(meta.paths) && meta.paths.length ? meta.paths[0] : null);
  const scopeText = primaryPath ? ` (${primaryPath})` : '';

  let guidance = 'Re-run the tool with a narrower scope to reload the required details.';
  if (toolName === 'readFile' || toolName === 'readMultipleFiles') {
    guidance = primaryPath
      ? `Use readFileLines(relativePath="${primaryPath}", startLine=…, numLines=…) or readFileChunk(relativePath="${primaryPath}", offset=…, limit=…) to load the specific section you need.`
      : 'Use readFileLines/readFileChunk on the relevant file to reload specific sections.';
  } else if (toolName === 'searchInFiles') {
    guidance = 'Refine the regex or filePattern and rerun searchInFiles to inspect specific matches.';
  }

  const summary = `${toolName}${scopeText}`;
  const content = `[Context trimmed] ${summary} output omitted to stay within the token budget.
${guidance}`;

  return { content, summary };
}

function applyContextBudgetGuard(messages, { tokenLimit, threshold, countTokens }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages,
      actions: [],
      tokenCount: countTokens(messages)
    };
  }

  const working = messages;
  const actions = [];
  let tokenCount = countTokens(working);

  if (tokenCount <= threshold) {
    return { messages: working, actions, tokenCount };
  }

  const toolIndices = working
    .map((msg, idx) => (msg && msg.role === 'tool' ? idx : -1))
    .filter((idx) => idx >= 0);

  if (toolIndices.length === 0) {
    return { messages: working, actions, tokenCount };
  }

  const preserve = 2;
  const primaryCandidates = toolIndices.slice(0, Math.max(0, toolIndices.length - preserve));
  const secondaryCandidates = toolIndices.slice(Math.max(0, toolIndices.length - preserve));

  const replaceWithPlaceholder = (idx) => {
    const msg = working[idx];
    if (!msg || msg.__meta?.placeholder) return false;
    const placeholder = buildToolPlaceholder(msg);
    msg.content = placeholder.content;
    if (msg.__meta) {
      msg.__meta.placeholder = true;
      msg.__meta.placeholderSummary = placeholder.summary;
    }
    actions.push({ index: idx, summary: placeholder.summary });
    return true;
  };

  for (const idx of primaryCandidates) {
    if (replaceWithPlaceholder(idx)) {
      tokenCount = countTokens(working);
      if (tokenCount <= threshold) break;
    }
  }

  if (tokenCount > threshold) {
    for (const idx of secondaryCandidates) {
      if (replaceWithPlaceholder(idx)) {
        tokenCount = countTokens(working);
        if (tokenCount <= threshold) break;
      }
    }
  }

  tokenCount = countTokens(working);
  if (tokenCount > tokenLimit) {
    throw new Error('[sendToAI] Unable to reduce context under token limit (' + tokenCount + ' > ' + tokenLimit + ') even after applying budget guard.');
  }

  return { messages: working, actions, tokenCount };
}

module.exports.__testing = {
  applyContextBudgetGuard,
  stripMeta,
  buildToolPlaceholder,
};

function writeDebugSnapshot({
  conversationId,
  conversationType,
  phase,
  selectedPromptType,
  systemPrompt,
  effectiveTools,
  toolsSummary,
  finalMessagesToUse,
  tokenLimit,
}) {
  try {
    const debugDir = path.join(__dirname, '..', '..', 'data', 'debug', 'prompts');
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${conversationId || 'unknown'}_${selectedPromptType}_${timestamp}.json`;
    const filepath = path.join(debugDir, filename);
    
    const snapshot = {
      timestamp: new Date().toISOString(),
      conversationId,
      conversationType,
      phase,
      selectedPromptType,
      promptLength: systemPrompt.length,
      systemPrompt,
      effectiveToolsSummary: toolsSummary,
      effectiveToolsCount: effectiveTools?.length || 0,
      effectiveTools,
      tokenLimit,
      finalMessagesCount: finalMessagesToUse?.length || 0,
      finalMessages: finalMessagesToUse?.map(m => ({
        role: m.role,
        contentPreview: typeof m.content === 'string' 
          ? m.content.slice(0, 200) + (m.content.length > 200 ? '...' : '')
          : m.content,
      })),
    };
    
    fs.writeFileSync(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('[sendToAI] Failed to write debug snapshot:', err.message);
  }
}
