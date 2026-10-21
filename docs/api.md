# API Documentation

This document describes the REST endpoints and real-time communication interfaces exposed by MiniBoss.

## Base URL

All REST endpoints are served under:

```
http://<host>:<port>/api
```

The default server port is `3001` and the default bind host is `127.0.0.1`. These can be changed with `PORT` and `HOST` environment variables.

## Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Returns server health status |

## Real-Time Communication

The server uses Socket.IO for live events. The Socket.IO endpoint path is:

```
/api/socket.io
```

Client-side socket usage is defined in `web/src/socketService.js`.

## REST Endpoints

### Projects API

Base path: `/api/projects`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List projects |
| GET | `/:id` | Get a project |
| POST | `/` | Create a project |
| PUT | `/:id` | Update a project |
| DELETE | `/:id` | Delete a project |
| GET | `/:id/extra-files/search` | Search extra files by name |
| GET | `/:id/extra-files/selected` | Get selected extra files |
| PUT | `/:id/extra-files/selected` | Set selected extra files |
| GET | `/:projectId/conversations` | List project conversations |
| POST | `/:projectId/conversations` | Create a project conversation |

### Conversations API

Base path: `/api/conversations`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:id` | Get a conversation |
| PUT | `/:id` | Update conversation title |
| PUT | `/:id/model` | Update conversation model/provider |
| DELETE | `/:id` | Delete a conversation |
| GET | `/:id/context` | Get conversation context metadata |
| GET | `/:id/parent` | Get parent conversation |
| GET | `/:id/sub-conversations` | List sub-conversations |
| GET | `/:id/focus-conversations` | List focus conversations |
| GET | `/:id/focus-tree` | Get focus tree |
| POST | `/:id/cancel` | Cancel active operation |
| POST | `/:id/clear` | Clear messages |
| GET | `/:id/git` | Get git state |
| GET | `/:id/git/diff` | Get git diff |
| POST | `/:id/git/commit` | Commit changes |
| POST | `/:id/git/merge` | Merge branch |
| POST | `/:id/git/reset` | Reset worktree |
| POST | `/:id/index` | Index project and worktree |
| POST | `/:id/reindex` | Re-index changed files |
| GET | `/:id/index-status` | Get indexing status |
| GET | `/:id/tasks` | Get task tree |
| GET | `/:id/plan` | Get conversation plan |
| PUT | `/:id/plan` | Update conversation plan |
| POST | `/:id/execute-plan` | Execute a conversation plan |
| PUT | `/:id/mode` | Update conversation mode |

### Messages API

Base path: `/api/messages`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/conversations/:conversationId/messages` | List messages |
| DELETE | `/:id` | Delete a message |

### Providers API

Base path: `/api/providers`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | List providers |
| GET | `/active` | Get active provider |
| GET | `/:id` | Get a provider |
| POST | `/` | Create a provider |
| PUT | `/:id` | Update a provider |
| DELETE | `/:id` | Delete a provider |
| POST | `/:id/activate` | Set active provider |
| POST | `/:id/refresh-pricing` | Refresh the pricing catalog of a provider (200 on success, 502 on provider error) |

### AI API

Base path: `/api/ai`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/models/:providerId` | Fetch models from provider |
| POST | `/search/index-project` | Index project files |
| POST | `/search/index-worktree` | Index worktree files |
| POST | `/search` | Semantic search |
| GET | `/search/status` | Get index status |

### Settings API

Base path: `/api/settings`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/:key` | Get a setting |
| POST | `/` | Create or update a setting |

### Search API

Base path: `/api/search`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/status` | Get indexing status |
| POST | `/index-project` | Index project |
| POST | `/index-worktree` | Index worktree |
| POST | `/` | Semantic search |

### Sandbox API

Base path: `/api/sandbox`

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/paths` | List sandbox paths |
| POST | `/paths` | Add sandbox path |
| PUT | `/paths/:id` | Update sandbox path |
| DELETE | `/paths/:id` | Remove sandbox path |

---

## Cost accounting

### Settings

| Key | Default | Description |
|-----|---------|-------------|
| `allow_paid_models` | `false` | While `false`, models with a known positive price are hidden in the model picker and rejected by the server (`403` on `PUT /api/conversations/:id/model`, and the AI call is refused with a clear message). |
| `sandbox_image` | `docker.io/library/node:22-bookworm` | Image used by the Podman sandbox. |

### Aggregated usage

`GET /api/conversations/:id/context` (and the `context_info` socket event) expose:

| Field | Description |
|-------|-------------|
| `total_cost` | Sum of the priced calls. `null` when the total is unknown. |
| `cost_coverage` | `priced_calls / (priced_calls + unpriced_calls)` — `1` when every call is priced. |
| `cost_partial` | `true` when at least one call has no known price. |
| `priced_calls` / `unpriced_calls` | Number of priced and unpriced AI calls. |
| `models_breakdown` | Per-model cost, call count and unpriced call count. |

The UI shows `≈ $X` when the total is partial and `—` when it is unknown. An unknown
price is never rendered as `$0.00`.

### Audit scripts

```sh
# Recompute every recorded cost with the current algorithm and compare it with
# the stored value. Exits non-zero when the delta is above the tolerance (1%),
# when a call is unpriced, or when a usage block has no matching row.
node server/scripts/costAudit.js [--conversation <id>] [--since YYYY-MM-DD] [--tolerance 1] [--no-network]

# Ground-truth probe: sends one fixed small request and prints the computed cost.
node server/scripts/costProbe.js --model <model-id> [--provider <id>] [--json]
```

**Ground-truth procedure** (the check that the cost MiniBoss reports matches the
provider's billing):

1. Run `node server/scripts/costProbe.js --model anthropic/claude-sonnet-5`.
   The script refreshes the catalog, sends the request and prints the usage, the
   price it used and the computed cost.
2. Open the provider dashboard (Kilo → Usage) and find the same request — it is
   the one with the probe's prompt and the printed token counts.
3. Compare the two amounts. They must agree, with **one documented exception**:
   the OpenAI-compatible response does not expose the cache counters, so a cached
   prompt is billed *cheaper* by the provider than the estimate printed by the
   probe. The cache prices are stored in the catalog, so the estimate can be
   corrected as soon as the provider exposes the counters.
4. Only after the numbers agree, flip `allow_paid_models` to `true`.
| GET | `/browse` | Browse directory entries |
