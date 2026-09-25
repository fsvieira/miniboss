# Architecture Overview

This document describes the current MiniBoss architecture, the main integration paths, the highest-risk areas, and the intended direction. It is a reference, not an implementation plan.

## 1. System Boundaries

MiniBoss is split into three operational layers:

- UI: browser client (`web/src`)
- API/UI bridge: Express + Socket.IO server (`server/`)
- Data and worker backend: SQLite-backed services, queue manager, focus runtime

The server is the source of truth for conversations, messages, approvals, projects, providers, and focus runtime state. The UI may cache derived state, but it should not reinterpret authoritative server events.

## 2. Technology Summary

- Server: Node.js, Express, Socket.IO
- UI: React + Vite, Material UI, MobX
- State: MobX on the client; SQLite plus in-memory service state on the server
- Runtime: event loop dispatching message work
- Storage: SQLite

## 3. Server Architecture

### Bootstrap

`server/index.js` wires the application:
- creates Express, HTTP server, and Socket.IO
- initializes the socket service
- initializes the event loop
- exposes `io` to routes and controllers that need broadcasting

### HTTP Routes

`server/routes/*` expose most non-streaming functionality. Live chat and streaming behavior are socket-driven.

### Socket Service

`server/services/socketService.js` manages:
- socket rooms and event forwarding
- approval lifecycle and expiry sweep
- focus notifications
- `join-conversation` and `leave-conversation` semantics

### Controllers

- `server/controllers/aiController.js` is the highest-risk concentration of behavior:
  - active operations, pending approvals, approval handlers
  - focus lifecycle, focus chain cancellation, focus report editing
  - provider and LLM orchestration, tool execution orchestration, retry and error handling
- `server/controllers/messageController.js` handles message broadcasting
- `server/controllers/systemPromptBuilder.js`, `tokenController.js`, `toolUtils.js`, `llmUtils.js`, and `conversationUtils.js` are narrower utilities and controllers

### Event Loop

`server/services/eventLoop/index.js` listens to a message queue and runs `processNext`. This layer is the likely owner of orchestration and should be treated as a key review target.

### Data and Services

- `server/services/db` wraps SQLite CRUD and transactions
- `server/services/context` builds runtime context
- `server/services/ai` provides AI client and provider plumbing
- `server/services/protocol` provides state machine foundations
- `server/services/focusRuntime` manages focus lifecycles and transitions

### Project Memory Conversation

- Each project has exactly one `project` conversation, created lazily and kept unique by database constraints.
- It operates read-only against the project folder and never receives a git worktree.
- Knowledge is stored as project notes and guided by a dedicated system prompt.
- Overview tools return deterministic conversation maps and read-only AI status reports without mutating the target conversation.
- Plan execution is represented by separate execution records linked to a normal conversation created in exec mode.

## 4. UI Architecture

### Bootstrap

- `web/src/main.jsx` mounts the application
- `web/src/App.jsx` coordinates projects, conversations, modals, view mode, and sidebar state

### State

- `web/src/stores/chatStore.js` is the main runtime store:
  - per-conversation observable state
  - focus thread stack and focus status maps
  - socket listeners for stream, approvals, and focus events
  - loading, unread, AI status, and tool indicator bookkeeping

### Socket Layer

- `web/src/socketService.js` is the client-side Socket.IO wrapper
  - manages connection lifecycle
  - joins and leaves conversation rooms
  - forwards server events to subscribers

### Views and Components

- `App.jsx`, `Sidebar`, `Chat`, `MessageList`, `MessageInput`, and related components form the main surface
- `FocusThreadView.jsx` and `FocusCard.jsx` implement focus UX

## 5. Current Architecture Issues

### 5.1 State Separation

- The server is partly the source of truth, but the UI also mutates project and conversation state in `App.jsx` instead of deriving it from `chatStore` and server responses.
- Duplicated state between `App.jsx` and `chatStore` increases the risk of divergence.

### 5.2 Conversation Lifecycle

- Start, stop, cancel, and recovery paths are split across `aiController.js`, the event loop, the socket service, and the message controller.
- Focus child cancellation is fragile and branches through several dynamic paths.

### 5.3 Focus Lifecycle

- Focus state is represented in multiple layers: runtime constants, focus runtime transitions, approval logic, reporting format, and cancellation logic.
- Recovery behavior exists but is narrow and tightly coupled to `events` and `aiController.js`.

### 5.4 Code Organization

- `aiController.js` and `chatStore.js` are large and accumulate side effects.
- Approval handling, tool execution, focus lifecycle, chat orchestration, and status updates are mixed in `aiController.js`.
- Socket room membership and broadcast assumptions are mostly implicit.

### 5.5 State Machine Usage

- A state machine implementation exists, but it is unclear how fully conversation and focus transitions are routed through it versus ad-hoc controller and runtime flags.

## 6. Recommended Priorities

1. Make the UI derive conversation and project state from `chatStore` and server responses alone.
2. Extract approval, focus, and tool orchestration out of `aiController.js` into domain-specific services.
3. Tighten focus runtime boundaries around the protocol state machine.
4. Make recovery behavior explicit and observable.
5. Document and enforce a strict socket event contract between server and UI.

## 7. Future Direction

### Vision

Move toward clean separation of concerns with explicit module boundaries, single ownership of state, and a stable event contract between backend and frontend.

### Target Layers

1. Presentation: UI components, MobX stores, socket client abstraction
2. Application: HTTP routes, socket orchestration, narrow controllers
3. Domain: AI client, context building, focus runtime, protocol and state machine
4. Infrastructure: database access, event loop, application bootstrap

### Target Modules

- `conversation`: conversation lifecycle and relationships
- `focus`: focus execution, state transitions, and reporting
- `approval`: approval lifecycle and user interaction
- `message`: message persistence and broadcasting
- `provider`: LLM provider abstraction

### Principles

- Single responsibility per module
- High-level modules depend on abstractions, not low-level details
- Socket events follow a documented contract
- State is owned by one module and queried by others
- All resources have explicit creation and cleanup paths
