# MiniBoss

**MiniBoss is a project-aware AI development assistant for working across multiple Git projects without switching IDEs.** It combines persistent project memory, isolated Git worktrees, and a sandboxed execution environment so you can plan, implement, and review work from one place.

Every project you add to MiniBoss must already be a Git repository.

> **Notice:** MiniBoss is under active development. It may contain bugs or breaking changes. You are welcome to try it, but use it with care.

## Security

MiniBoss uses Git worktrees together with a **rootless Podman** sandbox to limit the assistant's access:

- The assistant operates inside the active worktree. The worktree is bind-mounted inside an isolated container at the same absolute path, so nothing is written outside it from within an execution conversation.
- The base repository is mounted **read-only**; it is only modified through explicit Git operations that you initiate in the Git section.
- The container runs with `--userns=keep-id` (so the files it writes stay owned by your user), `--cap-drop=ALL` and `no-new-privileges`.
- The container receives an **explicit environment allowlist** (`HOME`, `PATH`, `LANG`, `TZ`, `CI`) — the host environment is never leaked into the command.
- One container is kept per conversation worktree, so the npm cache and the project setup survive between commands. Idle containers are stopped (not deleted) and removed when the conversation is deleted.
- The **output of a command is transported through files**: the command writes its stdout, stderr and exit code into a scratch directory that is bind-mounted read-write in the container, and the server reads the files back. The stream of `podman exec` is only a fallback — it intermittently comes back empty, which used to leave the assistant without any output.
- The container has its own npm cache (`/home/miniboss/.npm`). Do **not** share the host `~/.npm` (or `~/.nvm`): the cache is 12 GB and the host Node versions conflict with the one of the container.

However, this boundary is **not absolute**:

- If the assistant invokes external services—such as a MySQL database, remote APIs, or other networked tools—those interactions are **not** confined by the worktree sandbox. The sandbox controls filesystem and process isolation within the worktree; it does not restrict outbound connections or external state changes.
- **The file tools (`writeFile`, `editFile`, `moveFile`, `deleteFile`, `copyFile`, `createDirectory`) are not sandboxed**: they write directly to the host filesystem. In plan mode they are removed from the tool list and blocked by the tool processor, but the command sandbox is the only boundary for `runCommand`.
- Extra paths configured in the **Sandbox** settings are mounted into the container according to their access mode (`read` or `write`); treat a `write` entry as granting the assistant write access to that path.

The sandbox is currently **Linux-only** and requires rootless Podman (`podman`) to be installed and working. MiniBoss verifies it on startup and will not run without it. The previous bubblewrap sandbox is still available with `SANDBOX_RUNTIME=bwrap`.

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_RUNTIME` | `podman` | `podman` or `bwrap` |
| `SANDBOX_IMAGE` | `docker.io/library/node:22-bookworm` | Container image |
| `SANDBOX_IDLE_TTL_MIN` | `10` | Minutes after which an idle container is stopped |
| `SANDBOX_NETWORK` | `default` | `default` (rootless network) or `none` |
| `SANDBOX_CONTAINER_HOME` | `/home/miniboss` | `HOME` inside the container (also the npm cache) |
| `SANDBOX_SHM_SIZE` | `1g` | Size of `/dev/shm` inside the container (empty disables the flag) |
| `SANDBOX_ULIMIT_STACK` | `65536:65536` | Stack limit of the commands run in the container (only the soft limit is effective) |
| `SANDBOX_ULIMIT_STACK_CREATE` | `0` | Also pass `--ulimit stack=` to `podman create` (see below) |
| `SANDBOX_IO_DIR` | `<data>/sandbox/io` | Host directory of the output exchange (one subdirectory per conversation) |
| `SANDBOX_IO_MOUNT_TARGET` | `/var/lib/miniboss/io` | Mount point of the output exchange inside the container |
| `SANDBOX_GLOBAL_SETUP` | `1` | Runs the global setup script once per container (`0` disables it) |
| `SANDBOX_GLOBAL_SETUP_SCRIPT` | `<data>/sandbox/setup.sh` | Global setup script (generic CLI tools missing from the image) |
| `SANDBOX_SETUP_SCRIPT` | `.miniboss/setup.sh` | Repository setup script, relative to the conversation worktree |
| `PODMAN_BIN` | auto-detected | Path to the `podman` binary |

### The stack limit

The container starts with an 8 MB stack, which is too small for deep recursion and for some Node workloads. The limit is raised **inside the command** (with the `ulimit` builtin), not with `podman create --ulimit stack=`: in rootless containers that flag makes the `apt` method crash with `SIGSEGV`, which would break the global setup script. Set `SANDBOX_ULIMIT_STACK_CREATE=1` to also pass it to `podman create` on hosts where that works.

### The global setup script

The image `node:22-bookworm` does not ship the CLI tools the assistant often needs. On startup MiniBoss writes a default script to `SANDBOX_GLOBAL_SETUP_SCRIPT` when it does not exist yet — edit it to install something else. The script runs **once per container, as root** (it adds ~20-40 s to the first command of each conversation); a failure is not fatal and the container keeps working. Set `SANDBOX_GLOBAL_SETUP=0` to disable it.

The global script holds the **generic** toolbox only — the tools useful in any project (`jq`, `ripgrep`, `iproute2`). Anything project-specific belongs in the **repository** setup script:

| | Global | Repository |
|---|---|---|
| Path | `<data>/sandbox/setup.sh` | `<worktree>/.miniboss/setup.sh` |
| Scope | every project | only the project that owns the worktree |
| Contents | generic tools | project-specific tools (e.g. `sqlite3` for the MiniBoss `chat.db`) |
| Order | first | right after the global one |

The repository script is looked up **inside the conversation worktree**, so a `.miniboss/setup.sh` committed to the project repository travels with it automatically (the worktree is a git worktree of that repository). It must be committed — a file that only exists in the working copy of the main checkout is not present in the worktree. `SANDBOX_SETUP_SCRIPT` changes the relative path (e.g. `scripts/sandbox-setup.sh`).

### Installing Podman without root

Rootless Podman works without any system package, using the static build:

```bash
curl -fsSL -o podman.tar.gz \
  https://github.com/mgoltzsche/podman-static/releases/latest/download/podman-linux-amd64.tar.gz
tar xzf podman.tar.gz
cp -r podman-linux-amd64/usr podman-linux-amd64/etc ~/
```

Then point `~/.config/containers/containers.conf` at the helper binaries
(`conmon`, `crun`, `netavark`) and expose a `podman` wrapper in `~/.local/bin`.
Without the `uidmap` package (`newuidmap`/`newgidmap`) the container can only
map a single UID — enough for the sandbox, since `--userns=keep-id` maps the
container root to the host user, but the full sub-UID range is preferable:

```bash
sudo apt-get install -y podman uidmap
```


## Features

- **Project memory** — persistent notes about decisions, architecture, pending work, and context across sessions.
- **Worktree isolation** — implementation work happens in dedicated Git worktrees, keeping changes separate from your main branch and from other tasks.
- **Sandboxed execution** — the assistant operates inside the active worktree, with filesystem and command access restricted by project settings.
- **Settings & providers** — configurable sandbox rules, tool providers, and per-project behavior.
- **Execution conversations** — focused sessions for modifying, testing, and reviewing code with approval gates.
- **Git operations** — inspect, commit, merge, and manage branches from within execution conversations.

## Screenshots

![Settings / sandbox / providers](./docs/screenshots/settings-sandbox-providers.png)
*Project settings, sandbox controls, and provider configuration.*

![Settings / sandbox / providers](./docs/screenshots/settings-sandbox.png)
*Project settings, sandbox global permissions example.*

![Project Memory + plan / execute](./docs/screenshots/project-memory-plan-execute.png)
*Persistent project memory alongside plan and execute workflows.*

![Execution conversation with TODO + plan](./docs/screenshots/execution-conversation-todo-plan.png)
*Focused execution session with TODO list and embedded plan.*

![Execution conversation + Git](./docs/screenshots/execution-conversation-git.png)
*Reviewing code changes, commit, and merge inside an execution conversation.*

## Setup

Use `server/.env.example` as a template to create your local `server/.env`. This file is local-only and not committed to Git.

## Quick Start

### Prerequisites

- Node.js v18+
- npm

### Install

```bash
npm install
cd server && npm install
cd ../web && npm install
```

### Run

Start the backend:

```bash
cd server
npm run start
```

Then start the web client:

```bash
cd web
npm run dev
```

Frontend: http://localhost:5300  
Backend: http://localhost:3200

In development, Vite proxies `/api` to the backend.

For a production build of the frontend:

```bash
cd web
npm run build
```

Serve the built `web/dist` assets from your web server and proxy `/api` to the backend.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow, and pull request guidelines.

## License

MIT — see [LICENSE](LICENSE) for details.
