# Development Guidelines

## Guiding Principles

- Analysis and documentation only. Do not implement code changes unless a focused task explicitly includes implementation.
- Each focus must execute the **first critical step** and stop.
- If a blocker arises, create **exactly one sub-focus** to resolve it; do not chain unprompted work.
- Outputs should be concise, actionable, and useful for future contributors.

## 1. State Separation

- **Server is the source of truth** for conversations, messages, focus runtime, provider config, approvals, and project associations.
- **Client is a view layer only.** Do not let UI reconstruct canonical state from local assumptions.
- Never assert authority over source-of-truth domains from the UI.

### Client rules
- Treat all messages, approvals, and focus reports as **authoritative** when received server-side.
- Client state must be reloadable from server responses; do not keep long-lived state that cannot be resynchronized.
- Do not simulate approval or tool results locally.
- Only UI-only state (modals, view mode, selected IDs, scroll position) belongs on the client; everything else should derive from server- or derived-server state.

### Server rules
- All mutation of primary state goes through database services.
- Broadcasts through Socket.IO must be the only mechanism used to notify UI.
- No code may make authoritative claims about conversation state without querying database or runtime state.

## 2. Conversation State Machine and Lifecycle

- A conversation must have a clearly defined lifecycle. Do not rely on implicit status flags.
- One active generation path per conversation at a time. A new operation must cancel the previous one.
- Cancelling a conversation also cancels **all descendant focus conversations**.
- Every crash or restart must trigger explicit recovery: orphan focuses must be marked and parent conversations notified.

### Recommended lifecycle states for a conversation or focus operation
- `idle`: no active generation
- `generating`: LLM is producing output
- `executing_tools`: tool calls are in progress
- `awaiting_approval`: waiting for user whether approved/denied
- `cancelling`: cancel is requested; cleanup in progress
- `completed` / `failed` / `cancelled` / `interrupted`: terminal states
- State transitions should go through a well-defined state machine. Ad-hoc status mutations are not allowed.

## 3. Code Organization

- Server and web folders remain clearly separated.
- Group code by responsibility; do not put domain-unrelated concerns in the same file.
- Limit file size. If a module exceeds a few hundred focused lines, split it into sub-modules.
- Controllers handle orchestration. Database services handle data access and transactions.
- AI client, context builder, socket service, and focus runtime each remain independent.

### Naming and placement rules
- Routes go in `server/routes/`.
- API-accessing server code goes through `server/services/db/...` or dedicated fetch helpers.
- UI services go in `web/src/services/`.
- Reusable UI state goes in `web/src/stores/`.
- Conference/threaded UI components live in `web/src/components/`.

## 4. Testing and Debugging

- Backend tests live in `server/tests/`.
- UI unit tests stay near the source file when needed.
- Use explicit service contracts for debugging:
  - one input source,
  - one mutation authority,
  - one notification path.

### Debugging requirements
- Every state change must be traceable, via:
  - runtime state machine events, or
  - database records, or
  - explicit socket events.
- Do not rely on incidental console output for correctness reasoning.
- For approvals and focus reports, always persist an audit record.

## 5. Workspace Usage Rules

- Backend code works in the app source tree only.
- Worktree runs are ephemeral sandboxes for agent actions.
- Keep file changes minimal for reading, querying, or analysis.
- Main repo state must remain valid after any action.

## 6. FOCUS Protocol Conventions

- Do not kill the parent focus.
- Create exactly one sub-focus per blocker.
- Handoffs must include status, evidence, and rationale to justify the next agent’s action.
