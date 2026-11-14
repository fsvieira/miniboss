const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  getSandboxConfig,
  resolvePodmanBinary,
  buildPodmanEnv,
  hasNewuidmap,
  getSandboxIoDir,
  getSandboxIoKey,
  getSandboxStackLimit,
  getProjectSandboxCacheDir,
  resolveSandboxImage,
} = require('./runtime');

/**
 * Podman sandbox executor.
 *
 * One persistent container per conversation worktree (decision D1): every
 * `runCommand` is a `podman exec`, so the npm cache and the setup survive
 * between commands (~50 ms instead of ~500 ms for `podman run`).
 *
 * The container is created with:
 *   - the worktree bind-mounted at the **same absolute path** (so the absolute
 *     paths used in tool descriptions and prompts stay valid inside the
 *     container, and the file tools — which bypass the container — see the
 *     edits instantly);
 *   - the repository root mounted read-only;
 *   - `--userns=keep-id` (mandatory: without it the files written inside the
 *     container become root-owned on the host and break git operations);
 *   - an explicit env allowlist (no host env leakage).
 */

// ── In-memory state (per process) ──────────────────────────────────────────

/**
 * Capabilities kept inside the container.
 *
 * `--cap-drop=ALL` alone is too strict: the container root (which `--userns=keep-id`
 * maps to the *host* user) would not be able to write to the worktree, because
 * DAC_OVERRIDE is exactly the capability that bypasses the file mode checks.
 *
 * This is the podman default set: no NET_ADMIN, no SYS_ADMIN, no SYS_PTRACE,
 * no SYS_MODULE — the container cannot change the network or the host.
 */
const CONTAINER_CAPABILITIES = [
  'CHOWN',
  'DAC_OVERRIDE',
  'FOWNER',
  'FSETID',
  'KILL',
  'SETFCAP',
  'SETGID',
  'SETPCAP',
  'SETUID',
];

/**
 * Init command of the sandbox container. PID 1 ignores unhandled signals, so a
 * plain `sleep infinity` container can never be stopped (`podman stop` times
 * out). This shell forwards the signal to the whole process group and exits.
 */
const INIT_COMMAND = 'trap "kill -TERM 0" TERM INT; sleep infinity & wait';

/**
 * Version of the container specification (capabilities, exec user, init command…).
 * It is part of the container identity: when it changes, the containers created
 * by an older version of MiniBoss are recreated instead of being reused.
 */
const CONTAINER_SPEC_VERSION = '4';

/** @type {Map<string, Object>} conversationId -> container state */
const containerStates = new Map();

/** @type {Map<string, number>} container name -> last activity timestamp */
const lastActivity = new Map();

// ── Argument builders (pure — unit tested) ─────────────────────────────────

/**
 * Builds the bind mount map.
 *
 * @param {Object} params
 * @param {string} params.repoRoot
 * @param {string} params.worktreePath
 * @param {boolean} [params.readOnlyWorktree]
 * @param {Array<{path: string, writable: boolean}>} [params.extraPaths]
 * @param {string} [params.ioDir] - Host directory of the output exchange.
 * @param {string} [params.ioTarget] - Mount point of the exchange inside the container.
 * @param {string} [params.cacheDir] - Host directory of the persistent cache.
 * @returns {Array<{source: string, target: string, readOnly: boolean}>}
 */
function buildMountMap(params = {}) {
  const {
    repoRoot,
    worktreePath,
    readOnlyWorktree = false,
    extraPaths = [],
    ioDir = null,
    ioTarget = null,
    cacheDir = null,
  } = params;

  const mounts = [];
  const seen = new Set();

  const push = (source, readOnly, target = source) => {
    if (!source) return;
    const resolved = path.resolve(source);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    mounts.push({ source: resolved, target: path.resolve(target), readOnly });
  };

  // The worktree is mounted first so that it wins over the repository root when
  // both are the same path (the `project` conversation type works directly on
  // the real project folder, which is always read-only).
  const resolvedRepo = repoRoot ? path.resolve(repoRoot) : null;
  const resolvedWorktree = path.resolve(worktreePath || repoRoot);
  const worktreeIsRepo = resolvedRepo != null && resolvedWorktree === resolvedRepo;

  push(resolvedWorktree, worktreeIsRepo ? true : readOnlyWorktree === true);
  push(repoRoot, true);

  for (const entry of extraPaths || []) {
    const target = entry?.path || entry;
    if (!target) continue;
    const resolved = path.resolve(target);
    if (!fs.existsSync(resolved)) {
      console.warn(`[podmanExecutor] Skipping sandbox path (does not exist): ${resolved}`);
      continue;
    }
    push(resolved, !(entry.writable === true || entry.access_mode === 'write'));
  }

  // Persistent cache (Deno/npm/Playwright downloads…): it lives on the host so
  // it survives the container recreation. The golden container of the project
  // mounts the same directory, so what it warms is reused by the sandboxes.
  if (cacheDir) {
    const resolvedCache = path.resolve(cacheDir);
    if (fs.existsSync(resolvedCache)) {
      push(resolvedCache, false, path.posix.join(getSandboxConfig().containerHome, '.cache'));
    } else {
      console.warn(`[podmanExecutor] Skipping sandbox cache directory (does not exist): ${resolvedCache}`);
    }
  }

  // The output exchange: the command writes stdout/stderr/exit-code there and
  // the host reads the files back. It is read-write on purpose (scratch space)
  // and lives outside the worktree, so the read-only guarantee of plan mode
  // is not affected.
  if (ioDir && ioTarget) {
    const resolvedIo = path.resolve(ioDir);
    if (fs.existsSync(resolvedIo)) {
      push(resolvedIo, false, ioTarget);
    } else {
      console.warn(`[podmanExecutor] Skipping sandbox I/O directory (does not exist): ${resolvedIo}`);
    }
  }

  return mounts;
}

/**
 * Stable key of the mount map — used to detect a container whose mounts are
 * outdated (e.g. plan mode flipped the worktree to read-only).
 * It is a digest so it can be stored safely in a podman label.
 *
 * The target is part of the key: the same source mounted at two different
 * targets is a different mount map.
 *
 * @param {Array<{source: string, target: string, readOnly: boolean}>} mounts
 * @returns {string}
 */
function buildMountsKey(mounts) {
  const payload = mounts
    .map(m => `${m.source}->${m.target || m.source}:${m.readOnly ? 'ro' : 'rw'}`)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(`${CONTAINER_SPEC_VERSION}|${payload}`).digest('hex').slice(0, 16);
}

/**
 * Stable key of a PATH string — used to detect a container whose PATH is
 * outdated (the PATH is fixed at `create` time through `-e PATH=…`).
 * It is a digest so it can be stored safely in a podman label.
 *
 * @param {string} containerPath
 * @returns {string}
 */
function buildPathKey(containerPath) {
  return crypto.createHash('sha1').update(String(containerPath || '')).digest('hex').slice(0, 16);
}

/**
 * Builds the environment allowlist passed to the container (decision D7).
 *
 * @param {Object} params
 * @param {Array<string>} [params.exportPaths] - Sandbox paths exported to PATH.
 * @param {Array<string>} [params.configuredPaths] - Every configured sandbox path.
 * @param {string} [params.worktreePath] - Worktree whose local bins are added to PATH.
 * @param {string} [params.basePath] - PATH captured from the project golden
 *   container. When absent, the configured default PATH is used.
 * @returns {Object}
 */
function buildContainerEnv(params = {}) {
  const config = getSandboxConfig();
  const exportPaths = (params.exportPaths || []).filter(Boolean);
  const configured = new Set((params.configuredPaths || []).filter(Boolean).map(p => path.resolve(p)));
  const basePath = String(params.basePath || '').trim() || config.containerPath;

  const imagePath = [];
  for (const entry of basePath.split(':')) {
    if (!entry) continue;
    // A configured path that is NOT exported is removed from PATH.
    if (configured.has(path.resolve(entry)) && !exportPaths.includes(entry)) continue;
    if (!imagePath.includes(entry)) imagePath.push(entry);
  }

  const merged = [...imagePath];
  for (const p of exportPaths) {
    if (p && !merged.includes(p)) merged.push(p);
  }

  // Project-local binaries (the setup script often installs shims there) and
  // the node_modules bins must be reachable by every command, not only by the
  // setup process. A non-existent directory in PATH is harmless.
  if (params.worktreePath) {
    const localBins = [
      path.join(params.worktreePath, '.miniboss', 'bin'),
      path.join(params.worktreePath, 'node_modules', '.bin'),
    ];
    for (const p of localBins) {
      if (!merged.includes(p)) merged.push(p);
    }
  }

  const cacheHome = path.posix.join(config.containerHome, '.cache');
  return {
    HOME: config.containerHome,
    PATH: merged.join(':'),
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    CI: '1',
    XDG_CACHE_HOME: cacheHome,
    NPM_CONFIG_CACHE: path.posix.join(cacheHome, 'npm'),
  };
}

/**
 * Builds the `podman create` argument vector.
 *
 * @param {Object} params
 * @param {string} params.name - Container name.
 * @param {string} params.image
 * @param {Array<{source: string, target: string, readOnly: boolean}>} params.mounts
 * @param {Object} params.env
 * @param {Object} params.labels
 * @param {string} params.workdir
 * @param {string} [params.network]
 * @param {number} [params.stopTimeoutSeconds]
 * @param {string} [params.shmSize] - Size of /dev/shm (empty disables the flag).
 * @param {string} [params.ulimitStack] - `soft:hard` stack limit (empty disables the flag).
 * @returns {string[]}
 */
function buildCreateArgs(params = {}) {
  const { name, image, mounts = [], env = {}, labels = {}, workdir, network, stopTimeoutSeconds = 10 } = params;

  const config = getSandboxConfig();
  const shmSize = params.shmSize != null ? String(params.shmSize).trim() : config.shmSize;
  // The stack limit is only passed to `podman create` when it is explicitly
  // asked for: in rootless containers it makes the apt method crash with
  // SIGSEGV, which would break the global setup. By default the limit is
  // applied inside the command (see `execInContainer`).
  const ulimitStack = params.ulimitStack != null
    ? String(params.ulimitStack).trim()
    : (config.ulimitStackCreate ? config.ulimitStack : '');

  const args = [
    'create',
    '--name', name,
    // Without keep-id the files written inside the container become root-owned
    // on the host and break git commit/merge in gitService.
    '--userns=keep-id',
    '--cap-drop=ALL',
    '--cap-add', CONTAINER_CAPABILITIES.join(','),
    '--security-opt=no-new-privileges',
  ];

  // /dev/shm defaults to 64 MB inside the container: too small for
  // Chromium-based tools and for some Node workloads.
  if (shmSize) args.push('--shm-size', shmSize);
  if (ulimitStack) args.push('--ulimit', `stack=${ulimitStack}`);

  for (const [key, value] of Object.entries(labels)) {
    args.push('--label', `${key}=${value}`);
  }

  for (const mount of mounts) {
    const suffix = mount.readOnly ? ':ro' : ':rw';
    args.push('-v', `${mount.source}:${mount.target}${suffix}`);
  }

  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }

  if (workdir) args.push('-w', workdir);
  if (network && network !== 'default') args.push('--network', network);
  if (stopTimeoutSeconds > 0) args.push('--stop-timeout', String(stopTimeoutSeconds));

  // PID 1 of a container ignores signals that have no handler, so `podman stop`
  // would never terminate the container. The shell forwards the signal to the
  // whole process group and then exits.
  args.push(image, '/bin/sh', '-c', INIT_COMMAND);
  return args;
}

/**
 * Builds the `podman exec` argument vector.
 *
 * The command runs as the **host user** (its uid inside the container is the
 * same, thanks to `--userns=keep-id`), so it owns the worktree and can write to
 * it without needing any capability. The image's own USER (the node image uses
 * `node`) is deliberately not used: that uid maps to a subuid and the files
 * would end up owned by a stranger.
 *
 * @param {Object} params
 * @param {string} params.name - Container name.
 * @param {string} params.cwd
 * @param {Object} params.env
 * @param {string} params.command
 * @param {string} [params.user] - Container user (default: the host user uid).
 * @returns {string[]}
 */
function buildExecArgs(params = {}) {
  const { name, cwd, env = {}, command } = params;
  const user = params.user != null ? params.user : String(os.userInfo().uid);

  const args = ['exec'];
  if (user) args.push('--user', user);
  if (cwd) args.push('-w', cwd);
  for (const [key, value] of Object.entries(env)) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(name, '/bin/sh', '-c', command);
  return args;
}

// ── podman process helpers ─────────────────────────────────────────────────

/**
 * Runs a podman command synchronously and captures its output.
 *
 * The child is always killed with SIGKILL when the timeout expires: podman can
 * block for a long time (e.g. waiting on D-Bus/logind) and would ignore SIGTERM,
 * which would hang the whole server.
 *
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [options]
 * @returns {{stdout: string, stderr: string, exitCode: number}}
 */
function runPodmanSync(args, options = {}) {
  const binary = resolvePodmanBinary();
  const result = spawnSync(binary, args, {
    env: buildPodmanEnv(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 60000,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    return { stdout: '', stderr: String(result.error.message || result.error), exitCode: 127 };
  }

  if (process.env.MINIBOSS_DEBUG_PODMAN) {
    console.error('[podmanExecutor] exec:', JSON.stringify({
      args: args.slice(0, 3),
      status: result.status,
      signal: result.signal,
      stdout: String(result.stdout || '').slice(0, 200),
      stderr: String(result.stderr || '').slice(0, 400),
    }));
  }

  // NOTE: spawnSync exposes the exit code as `status` (not `exitCode`).
  const exitCode = typeof result.status === 'number' ? result.status : 1;
  const stderr = String(result.stderr || '');
  if (exitCode !== 0 && result.signal) {
    // Killed by a signal (usually the timeout) — make the failure explicit.
    return {
      stdout: String(result.stdout || ''),
      stderr: `${stderr}\n[podman] terminated by ${result.signal}`.trim(),
      exitCode,
    };
  }

  return {
    stdout: String(result.stdout || ''),
    stderr,
    exitCode,
  };
}

/**
 * Runs a podman command asynchronously with a timeout, killing the whole
 * process group when it expires (podman has no native timeout for `exec`).
 *
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, timedOut: boolean}>}
 */
function runPodmanProcess(args, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const binary = resolvePodmanBinary();
    const child = spawn(binary, args, {
      env: buildPodmanEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let killed = false;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (killTimeoutId) clearTimeout(killTimeoutId);
    };

    child.stdout?.on('data', data => { stdout += data; });
    child.stderr?.on('data', data => { stderr += data; });

    const timeoutId = timeoutMs > 0 ? setTimeout(() => {
      killed = true;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (_) {}
    }, timeoutMs) : null;

    let killTimeoutId = null;

    child.on('close', (code, signal) => {
      if (killed && !killTimeoutId) {
        killTimeoutId = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch (_) {}
        }, 5000);
      }

      let exitCode = code;
      if (signal) {
        exitCode = 128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGKILL' ? 9 : 1);
      }
      if (killed && (code === null || code === 0)) exitCode = 124;

      if (resolved) return;
      resolved = true;
      cleanup();
      resolve({ stdout, stderr, exitCode: exitCode || (killed ? 124 : 0), timedOut: killed });
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(err);
    });
  });
}

// ── Output capture (file transport) ─────────────────────────────────────────

/**
 * Maximum size of the stdout/stderr read back from the container.
 * The LLM context is truncated to 3000 chars anyway — this is only a guard
 * against a runaway command filling the disk.
 */
const MAX_CAPTURE_BYTES = 256 * 1024;

/** Suffix of the file the container writes the exit code into. */
const CAPTURE_RC_SUFFIX = '.rc';
/** Suffix of the file the container writes stdout into. */
const CAPTURE_OUT_SUFFIX = '.out';
/** Suffix of the file the container writes stderr into. */
const CAPTURE_ERR_SUFFIX = '.err';
/** Suffix of the sentinel file that proves the exchange directory is mounted. */
const CAPTURE_PROBE_SUFFIX = '.probe';

/**
 * How long the host waits (after the `podman exec` stream closed early) for
 * the inner command to write the capture files, before falling back to the
 * stream. The race: `podman exec` intermittently closes the connection before
 * the command finishes, so `id.rc` does not exist yet — waiting a bounded
 * amount of time lets the still-running command write the files moments later.
 */
const CAPTURE_WAIT_MS = 4000;
/** Polling interval of `waitForCapture`. */
const CAPTURE_POLL_MS = 75;

/** Diagnostics of the output transport (file / fallback / divergence / waitMiss). */
const captureStats = { file: 0, fallback: 0, divergence: 0, waitMiss: 0 };

/** @type {number} Counter of the executions, so the capture ids never collide. */
let captureCounter = 0;

/**
 * Identifier of a capture — unique per execution.
 * @returns {string}
 */
function buildCaptureId() {
  captureCounter += 1;
  return `${process.pid}-${Date.now().toString(36)}-${captureCounter}`;
}

/**
 * Reads a text file, or null when it does not exist.
 * @param {string} filePath
 * @returns {string|null}
 */
function readTextFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
}

/**
 * Reads the capture files of an execution.
 * @param {string} ioDir
 * @param {string} id
 * @returns {{stdout: string|null, stderr: string|null, rc: string|null}}
 */
function readCaptureFiles(ioDir, id) {
  return {
    stdout: readTextFile(path.join(ioDir, `${id}${CAPTURE_OUT_SUFFIX}`)),
    stderr: readTextFile(path.join(ioDir, `${id}${CAPTURE_ERR_SUFFIX}`)),
    rc: readTextFile(path.join(ioDir, `${id}${CAPTURE_RC_SUFFIX}`)),
  };
}

/**
 * Pauses the current async flow.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits (with a bound) for the capture files of an execution to be written by
 * the inner command. `podman exec` intermittently closes its stream before the
 * command finishes; when that happens the exit-code file does not exist yet and
 * a single-shot read would wrongly fall back to the (empty) stream — and the
 * cleanup would delete the output the command is about to write.
 *
 * Polls `readCaptureFiles` until `id.rc` exists or the deadline passes.
 *
 * @param {string} ioDir
 * @param {string} id
 * @param {number} waitMs - Hard upper bound of the wait (the command timeout is capped here too).
 * @param {number} [intervalMs]
 * @returns {Promise<boolean>} True when the exit-code file appeared in time.
 */
async function waitForCapture(ioDir, id, waitMs, intervalMs = CAPTURE_POLL_MS) {
  if (!ioDir || !id) return false;
  const deadline = Date.now() + Math.max(0, waitMs);
  while (Date.now() < deadline) {
    const files = readCaptureFiles(ioDir, id);
    if (files.rc != null && String(files.rc).trim() !== '') return true;
    await sleep(intervalMs);
  }
  captureStats.waitMiss += 1;
  return false;
}

/**
 * Removes the capture files of an execution (best effort).
 * @param {string} ioDir
 * @param {string} id
 */
function cleanupCaptureFiles(ioDir, id) {
  if (!ioDir || !id) return;
  for (const suffix of [CAPTURE_OUT_SUFFIX, CAPTURE_ERR_SUFFIX, CAPTURE_RC_SUFFIX, CAPTURE_PROBE_SUFFIX]) {
    try {
      fs.rmSync(path.join(ioDir, `${id}${suffix}`), { force: true });
    } catch (_) {}
  }
}

/**
 * Truncates a captured stream to `MAX_CAPTURE_BYTES`.
 * @param {string} value
 * @returns {string}
 */
function truncateCapture(value) {
  const buffer = Buffer.from(String(value == null ? '' : value), 'utf8');
  if (buffer.length <= MAX_CAPTURE_BYTES) return buffer.toString('utf8');
  return `${buffer.subarray(0, MAX_CAPTURE_BYTES).toString('utf8')}\n[truncated]`;
}

/**
 * Builds the command that captures the output of the command into files.
 *
 * The command runs **once**: the `if` branch redirects stdout/stderr into the
 * exchange directory and records the exit code; the `else` branch is the
 * fallback used when the directory is not mounted (the output then comes
 * through the exec stream).
 *
 * The `timeout` wrapper stays inside the redirected block, so the exit code
 * file records `124` when the command runs out of time.
 *
 * @param {string} inner - The command to run (with the timeout wrapper).
 * @param {Object} options
 * @param {string} options.ioTarget - Mount point of the exchange inside the container.
 * @param {string} options.id - Identifier of the execution.
 * @returns {string}
 */
function buildCaptureCommand(inner, options = {}) {
  const { ioTarget, id } = options;
  if (!ioTarget || !id) return inner;

  const probe = path.posix.join(ioTarget, `${id}${CAPTURE_PROBE_SUFFIX}`);
  const out = path.posix.join(ioTarget, `${id}${CAPTURE_OUT_SUFFIX}`);
  const err = path.posix.join(ioTarget, `${id}${CAPTURE_ERR_SUFFIX}`);
  const rc = path.posix.join(ioTarget, `${id}${CAPTURE_RC_SUFFIX}`);

  // The sentinel only exists on the host side: when the directory is not
  // mounted the container cannot see it and falls back to the exec stream.
  const quoted = shellQuote(inner);

  return [
    `if [ -f ${shellQuote(probe)} ]; then`,
    `  sh -c ${quoted} > ${shellQuote(out)} 2> ${shellQuote(err)}`,
    `  printf %s "$?" > ${shellQuote(rc)}`,
    'else',
    `  sh -c ${quoted}`,
    'fi',
  ].join('\n');
}

/**
 * Resolves the result of a command from the capture files (authoritative) or
 * from the exec stream (fallback).
 *
 * @param {Object} params
 * @param {'file'|'stream'} [params.mode] - 'stream' ignores the capture files.
 * @param {string} [params.ioDir]
 * @param {string} [params.id]
 * @param {{stdout?: string, stderr?: string, exitCode?: number}} [params.stream]
 * @param {boolean} [params.timedOut] - The exec process was killed.
 * @returns {{stdout: string, stderr: string, exitCode: number, failed: boolean, timedOut: boolean, captureSource: string}}
 */
function resolveCapturedResult(params = {}) {
  const {
    mode = 'file',
    ioDir = null,
    id = null,
    stream = {},
    timedOut: streamTimedOut = false,
  } = params;

  const streamStdout = String(stream.stdout || '');
  const streamStderr = String(stream.stderr || '');
  const streamExitCode = typeof stream.exitCode === 'number' ? stream.exitCode : 0;

  let stdout = streamStdout;
  let stderr = streamStderr;
  let exitCode = streamExitCode;
  let source = mode === 'stream' ? 'stream' : 'fallback';
  let timedOut = Boolean(streamTimedOut) || streamExitCode === 124;

  if (mode === 'file' && ioDir && id) {
    const files = readCaptureFiles(ioDir, id);
    const rc = files.rc != null ? String(files.rc).trim() : '';

    if (rc !== '') {
      // The capture files are authoritative.
      const parsed = parseInt(rc, 10);
      exitCode = Number.isFinite(parsed) ? parsed : 0;
      stdout = files.stdout != null ? files.stdout : '';
      stderr = files.stderr != null ? files.stderr : '';
      source = 'file';
      timedOut = timedOut || exitCode === 124;
      captureStats.file += 1;
      if (streamStdout.trim() !== '' || streamStderr.trim() !== '') {
        captureStats.divergence += 1;
      }
    } else {
      // No exit code file: the capture did not happen (or the wait timed out).
      captureStats.fallback += 1;
      const fallbackNote = '[sandbox] output capture fell back to the exec stream';
      if (streamStdout.trim() !== '' || streamStderr.trim() !== '') {
        // Prefer the stream content to an empty result — never leave the
        // assistant blind when the files never made it in time.
        if (streamStdout.trim() === '' && streamStderr.trim() !== '') {
          stdout = streamStderr;
          stderr = fallbackNote;
        } else {
          stderr = [stderr, fallbackNote].filter(Boolean).join('\n');
        }
      } else if (!timedOut) {
        // Exit-0 command that produced neither capture files nor stream content:
        // surface the loss explicitly instead of returning silent empty.
        stderr = '[sandbox] capture lost: no output was captured for this command';
      } else {
        stderr = [stderr, fallbackNote].filter(Boolean).join('\n');
      }
    }
  }

  if (process.env.MINIBOSS_DEBUG_PODMAN) {
    console.error('[podmanExecutor] capture:', JSON.stringify({
      source,
      exitCode,
      stdoutBytes: Buffer.byteLength(String(stdout)),
      stderrBytes: Buffer.byteLength(String(stderr)),
      streamBytes: Buffer.byteLength(streamStdout),
      stats: captureStats,
    }));
  }

  return {
    stdout: truncateCapture(String(stdout).trim()),
    stderr: truncateCapture(String(stderr).trim()),
    exitCode,
    failed: exitCode !== 0,
    timedOut,
    captureSource: source,
  };
}

/**
 * Diagnostics of the output transport.
 * @returns {{file: number, fallback: number, divergence: number}}
 */
function getCaptureStats() {
  return { ...captureStats };
}

// ── Container lifecycle ────────────────────────────────────────────────────

/**
 * Container name for a conversation.
 * @param {number|string} conversationId
 * @returns {string}
 */
function containerNameFor(conversationId) {
  return `miniboss-${conversationId}`;
}

/**
 * Inspects a container.
 * @param {string} name
 * @returns {{exists: boolean, running: boolean, status: string, labels: Object, mountsKey: string|null, image: string|null, spec: string|null, pathKey: string|null}|null}
 */
function inspectContainer(name) {
  const inspectArgs = [
    'inspect', name,
    '--format',
    '{{.State.Status}}|{{index .Config.Labels "miniboss.mounts"}}|{{index .Config.Labels "miniboss.image"}}|{{index .Config.Labels "miniboss.spec"}}|{{index .Config.Labels "miniboss.path"}}',
  ];

  let result = runPodmanSync(inspectArgs, { timeoutMs: 20000 });
  if (result.exitCode !== 0 && !isContainerMissingError(result.stderr)) {
    // A transient podman failure (timeout, D-Bus…) must not be mistaken for a
    // missing container: retry once, and never recreate the container blindly.
    result = runPodmanSync(inspectArgs, { timeoutMs: 20000 });
    if (result.exitCode !== 0 && !isContainerMissingError(result.stderr)) {
      throw new Error(
        `Failed to inspect sandbox container ${name}: ${String(result.stderr || result.stdout || '').trim() || `exit code ${result.exitCode}`}`
      );
    }
  }

  if (result.exitCode !== 0) return null;

  const [status, mountsKey, image, spec, pathKey] = String(result.stdout || '').trim().split('|');
  return {
    exists: true,
    running: status === 'running',
    status,
    mountsKey: mountsKey && mountsKey !== '' ? mountsKey : null,
    image: image && image !== '' ? image : null,
    spec: spec && spec !== '' ? spec : null,
    pathKey: pathKey && pathKey !== '' ? pathKey : null,
  };
}

/**
 * Reasons why an existing container must be recreated: the mounts, the image,
 * the container specification and the PATH are fixed at `create` time.
 *
 * @param {Object|null} info - Result of `inspectContainer`.
 * @param {{mountsKey: string, image: string, spec: string, pathKey: string}} expected
 * @returns {Array<string>}
 */
function containerRecreateReasons(info, expected = {}) {
  const reasons = [];
  if (!info) return reasons;
  if (info.mountsKey !== expected.mountsKey) reasons.push('mount map changed');
  if (info.image !== expected.image) reasons.push('image changed');
  if (info.spec !== expected.spec) reasons.push('spec changed');
  if (info.pathKey !== expected.pathKey) reasons.push('PATH changed');
  return reasons;
}

/**
 * Ensures the container for a conversation exists, is running and has the
 * expected mount map. Recreates it when the mounts, the image or the container
 * specification changed (all of them are fixed at `create` time).
 *
 * @param {Object} params
 * @param {number|string} params.conversationId
 * @param {string} params.repoRoot
 * @param {string} params.worktreePath
 * @param {boolean} [params.readOnlyWorktree]
 * @param {Array<{path: string, writable: boolean}>} [params.extraPaths]
 * @param {Array<string>} [params.exportPaths]
 * @param {Array<string>} [params.configuredPaths]
 * @param {string} [params.ioDir] - Host directory of the output exchange.
 * @param {string} [params.ioTarget] - Mount point of the exchange inside the container.
 * @param {number|string} [params.projectId] - Project of the conversation (cache + image).
 * @param {string} [params.image] - Resolved image (defaults to the global one).
 * @param {string} [params.basePath] - PATH captured from the project golden container.
 * @param {string} [params.cacheDir] - Host directory of the persistent cache.
 * @param {boolean} [params.forceSetup] - Run the setup even if it failed recently.
 * @returns {Promise<{name: string, created: boolean, started: boolean, setupLog: string|null, setup: Object}>}
 */
async function ensureContainer(params = {}) {
  const config = getSandboxConfig();
  const {
    conversationId,
    repoRoot,
    worktreePath,
    readOnlyWorktree = false,
    extraPaths = [],
    exportPaths = [],
    configuredPaths = [],
    ioDir = null,
    ioTarget = config.ioMountTarget,
    projectId = null,
    basePath = null,
    forceSetup = false,
  } = params;

  const image = resolveSandboxImage(params.image);
  const cacheDir = params.cacheDir || getProjectSandboxCacheDir(projectId);
  const name = containerNameFor(conversationId);
  const stateKey = String(conversationId);
  const mounts = buildMountMap({
    repoRoot,
    worktreePath,
    readOnlyWorktree,
    extraPaths,
    ioDir,
    ioTarget,
    cacheDir,
  });
  const mountsKey = buildMountsKey(mounts);

  const env = buildContainerEnv({
    exportPaths,
    configuredPaths,
    worktreePath: worktreePath || repoRoot,
    basePath,
  });
  const pathKey = buildPathKey(env.PATH);
  const labels = {
    [config.label]: config.labelValue,
    'miniboss.conversation': String(conversationId),
    'miniboss.worktree': worktreePath || repoRoot || '',
    'miniboss.mounts': mountsKey,
    'miniboss.image': image,
    'miniboss.spec': CONTAINER_SPEC_VERSION,
    'miniboss.path': pathKey,
  };

  const info = inspectContainer(name);
  let created = false;
  let started = false;

  const recreateReasons = containerRecreateReasons(info, {
    mountsKey,
    image,
    spec: CONTAINER_SPEC_VERSION,
    pathKey,
  });

  if (info && recreateReasons.length > 0) {
    // These properties are fixed at create time — the container must be recreated.
    console.log(`[podmanExecutor] Recreating container ${name} (${recreateReasons.join(', ')})`);
    runPodmanSync(['rm', '-f', name], { timeoutMs: 30000 });
    containerStates.delete(stateKey);
  }

  if (!info || recreateReasons.length > 0) {
    const createArgs = buildCreateArgs({
      name,
      image,
      mounts,
      env,
      labels,
      workdir: worktreePath || repoRoot,
      network: config.network,
    });
    const createdResult = runPodmanSync(createArgs, { timeoutMs: 10 * 60 * 1000 });
    if (createdResult.exitCode !== 0) {
      const stderr = String(createdResult.stderr || '').trim();
      if (isImageMissingError(stderr)) {
        await pullImage(image);
        const retry = runPodmanSync(createArgs, { timeoutMs: 10 * 60 * 1000 });
        if (retry.exitCode !== 0) {
          throw new Error(`Failed to create sandbox container: ${String(retry.stderr || retry.stdout).trim()}`);
        }
      } else {
        throw new Error(
          `Failed to create sandbox container: ${stderr || createdResult.stdout || `exit code ${createdResult.exitCode}`}`
        );
      }
    }
    created = true;
  }

  const state = inspectContainer(name);
  if (state && !state.running) {
    const startResult = runPodmanSync(['start', name], { timeoutMs: 60000 });
    if (startResult.exitCode !== 0) {
      throw new Error(`Failed to start sandbox container: ${String(startResult.stderr || '').trim()}`);
    }
    started = true;
  }

  // Prepare the container HOME (the cache lives there), the output exchange
  // directory and detect the in-container timeout binary.
  const prepared = await prepareContainer(name, env, ioTarget);

  // Setup backoff: a setup that just failed must not be retried on every
  // command (the apt/npm log would flood stderr). It is retried when the
  // container is recreated, after the backoff, or when explicitly forced.
  const previousState = containerStates.get(stateKey) || null;
  const canRetrySetup = shouldRetrySetup(previousState, Date.now(), config.setupRetryMs, forceSetup);

  let setupLog = null;
  let setup = { status: 'skipped', exitCode: 0, summary: null };
  let setupFailedAt = previousState ? previousState.setupFailedAt || null : null;

  if (!canRetrySetup && previousState && previousState.setupStatus === 'failed') {
    // Still inside the backoff window: report the last failure without running
    // the setup again. The original timestamp is preserved so the backoff can
    // actually expire.
    setup = {
      status: 'failed',
      exitCode: previousState.setupExitCode || 0,
      summary: previousState.setupSummary || null,
    };
    setupLog = previousState.setupLog || null;
  } else {
    const logs = [];
    let failed = null;
    let ran = false;
    let repoSkippedReadOnly = false;

    if (!prepared.globalSetupDone && config.globalSetupEnabled && fs.existsSync(config.globalSetupScript)) {
      ran = true;
      const global = await runGlobalSetupScript(name, { timeoutMs: config.setupTimeoutMs });
      if (global.log) logs.push(global.log);
      if (!global.ok) failed = global;
    }

    // The repository setup writes project shims (`.miniboss/bin/deno`,
    // node_modules…) into the worktree. On a read-only worktree (project / plan
    // conversations) those writes fail by design, so the script is skipped
    // instead of failing: its tools must come from the project image, not from
    // a setup that cannot write.
    const repoSetupPath = path.join(worktreePath || repoRoot, config.setupScript);
    if (!failed && !prepared.setupDone && fs.existsSync(repoSetupPath)) {
      if (readOnlyWorktree) {
        repoSkippedReadOnly = true;
      } else {
        ran = true;
        const repo = await runSetupScript(name, worktreePath || repoRoot, {
          timeoutMs: config.setupTimeoutMs,
          env,
        });
        if (repo.log) logs.push(repo.log);
        if (!repo.ok) failed = repo;
      }
    }

    setupLog = logs.filter(Boolean).join('\n') || null;
    if (failed) {
      setup = {
        status: 'failed',
        exitCode: failed.exitCode || 0,
        summary: buildSetupSummary(setupLog),
      };
      setupFailedAt = Date.now();
    } else if (ran) {
      setup = { status: 'ok', exitCode: 0, summary: null };
      setupFailedAt = null;
    } else {
      setup = {
        status: 'skipped',
        exitCode: 0,
        summary: repoSkippedReadOnly
          ? '[setup skipped: read-only worktree — tools must be provided by the project image]'
          : null,
      };
      setupFailedAt = null;
    }

    if (ran) {
      // The setup runs as root (it needs apt), but the container root maps to a
      // subuid: the files it creates in the worktree/cache would be owned by a
      // stranger on the host. Give them back to the host user.
      repairSetupOwnership(name, env, worktreePath || repoRoot);
    }
  }

  containerStates.set(stateKey, {
    name,
    mountsKey,
    image,
    env,
    setupLog,
    setupStatus: setup.status,
    setupExitCode: setup.exitCode,
    setupSummary: setup.summary,
    setupFailedAt,
    timeoutBinary: prepared.timeoutBinary,
    ioDir,
    ioTarget,
  });

  lastActivity.set(name, Date.now());

  return { name, created, started, setupLog, setup };
}

/**
 * Gives the files created by the root setup back to the host user.
 *
 * `--userns=keep-id` maps the container root to a subuid, so a setup that runs
 * as root would leave the worktree shims and the persistent cache owned by a
 * stranger on the host (the user could no longer edit or delete them).
 *
 * @param {string} name
 * @param {Object} env
 * @param {string} [worktreePath]
 */
function repairSetupOwnership(name, env, worktreePath) {
  const uid = String(os.userInfo().uid);
  const targets = [path.posix.join(env.HOME, '.cache')];
  if (worktreePath) {
    targets.push(path.posix.join(worktreePath, '.miniboss'));
    targets.push(path.posix.join(worktreePath, 'node_modules'));
  }
  const command = targets
    .map(target => `[ -e ${shellQuote(target)} ] && chown -R ${uid} ${shellQuote(target)} || true`)
    .join('; ');
  runPodmanSync([
    'exec', '--user', 'root', name, '/bin/sh', '-c', command,
  ], { timeoutMs: 120000 });
}

/**
 * Whether the setup may run again.
 *
 * A failed setup is not retried on every command: it is retried when the
 * container is recreated (no previous state), after the backoff, or when the
 * user forces it.
 *
 * @param {Object|null} previousState
 * @param {number} now
 * @param {number} retryMs
 * @param {boolean} [force]
 * @returns {boolean}
 */
function shouldRetrySetup(previousState, now, retryMs, force = false) {
  if (force) return true;
  if (!previousState || !previousState.setupFailedAt) return true;
  return now - previousState.setupFailedAt >= retryMs;
}

/**
 * Builds the short summary of a setup log (the last lines, bounded).
 * @param {string|null} log
 * @param {number} [maxChars]
 * @returns {string|null}
 */
function buildSetupSummary(log, maxChars = 1200) {
  const text = String(log || '').trim();
  if (!text) return null;
  if (text.length <= maxChars) return text;
  return `…${text.slice(-maxChars)}`;
}

/**
 * Prepares the container: creates the HOME directory, the output exchange
 * directory and detects the `timeout` binary used to enforce the command
 * timeout inside the container.
 *
 * @param {string} name
 * @param {Object} env
 * @param {string} [ioTarget] - Mount point of the output exchange.
 */
async function prepareContainer(name, env, ioTarget) {
  const config = getSandboxConfig();
  const parts = [`mkdir -p ${shellQuote(env.HOME)} && chmod 777 ${shellQuote(env.HOME)}`];
  if (ioTarget) {
    // The exchange directory is a mount point: the mkdir is a no-op when it is
    // already there (and it creates the parent when the mount is missing).
    parts.push(`mkdir -p ${shellQuote(ioTarget)}`);
  }

  // Runs as the container root: the container root is mapped to the host user
  // (keep-id), so the HOME directory belongs to the user and not to root.
  await runPodmanProcess(buildExecArgs({ name, env, command: parts.join('; '), user: 'root' }), 30000);
  const timeoutBinary = detectTimeoutBinary(name, env);
  const setupDone = isSetupDone(name, config.setupMarkerPath);
  const globalSetupDone = isSetupDone(name, config.globalSetupMarkerPath);
  return {
    timeoutBinary,
    setupDone,
    globalSetupDone,
  };
}

/**
 * Detects the `timeout` binary inside the container using exit codes.
 *
 * stdout of `podman exec` is not reliable (it intermittently comes back
 * empty), so the detection must never depend on it.
 *
 * @param {string} name
 * @param {Object} env
 * @returns {string|null} The absolute path of the binary, or null.
 */
function detectTimeoutBinary(name, env) {
  const result = runPodmanSync([
    'exec', name, '/bin/sh', '-c',
    'if [ -x /usr/bin/timeout ]; then exit 0; elif [ -x /bin/timeout ]; then exit 2; else exit 1; fi',
  ], { timeoutMs: 20000 });
  if (result.exitCode === 0) return '/usr/bin/timeout';
  if (result.exitCode === 2) return '/bin/timeout';
  return null;
}

/**
 * Whether a setup script already ran in this container.
 *
 * The decision uses the exit code of `test -f`, never stdout: the `podman exec`
 * stream intermittently comes back empty and would make the setup run again on
 * every command.
 *
 * @param {string} name
 * @param {string} markerPath
 */
function isSetupDone(name, markerPath) {
  const result = runPodmanSync([
    'exec', name, '/bin/sh', '-c',
    `test -f ${shellQuote(markerPath)}`,
  ], { timeoutMs: 20000 });
  return result.exitCode === 0;
}

/**
 * Default content of the global setup script.
 *
 * The sandbox image (`node:22-bookworm`) does not ship the CLI tools the
 * assistant often needs. The script installs them once per container, as
 * root, and is a no-op when they are already there.
 *
 * Only the **generic** toolbox belongs here (it applies to every project):
 *   - `jq`      — JSON processing;
 *   - `ripgrep` — fast search (`grep` is slow on big repositories);
 *   - `iproute2`— `ip`/`ss`, to diagnose ports and network.
 *
 * Anything project-specific (a database CLI, a linter, a language toolchain)
 * belongs in the repository setup script (`<worktree>/.miniboss/setup.sh`),
 * which runs right after this one.
 */
const DEFAULT_GLOBAL_SETUP_SCRIPT = [
  '#!/bin/sh',
  '# Global sandbox setup — runs once per container, as root.',
  '# Only the tools that are useful in ANY project.',
  'set -e',
  'missing=""',
  'for tool in jq rg ip; do',
  '  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"',
  'done',
  'if [ -z "$missing" ]; then',
  '  exit 0',
  'fi',
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get update -qq',
  'apt-get install -y -qq --no-install-recommends jq ripgrep iproute2',
  'rm -rf /var/lib/apt/lists/*',
  '',
].join('\n');

/**
 * Writes the default global setup script when it does not exist yet, so the
 * user can edit it afterwards.
 *
 * @returns {string|null} The path of the script.
 */
function ensureGlobalSetupScript() {
  const config = getSandboxConfig();
  const scriptPath = config.globalSetupScript;
  if (fs.existsSync(scriptPath)) return scriptPath;

  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, DEFAULT_GLOBAL_SETUP_SCRIPT, { mode: 0o755 });
    console.log(`[podmanExecutor] Wrote the default global setup script to ${scriptPath}`);
    return scriptPath;
  } catch (err) {
    console.warn(
      `[podmanExecutor] Could not write the global setup script ${scriptPath}: ${err && err.message ? err.message : err}`
    );
    return null;
  }
}

/**
 * Detects the interpreter declared by the shebang of a setup script.
 * @param {string} content
 * @returns {'bash'|'sh'}
 */
function detectSetupInterpreter(content) {
  const firstLine = String(content || '').split('\n')[0] || '';
  return /\bbash\b/.test(firstLine) ? 'bash' : 'sh';
}

/**
 * Resolves how a setup script must be invoked.
 *
 * - `direct`: the script is executable — run it as `./script`, so the kernel
 *   honors its shebang (bash scripts with `set -o pipefail` work).
 * - `bash`/`sh`: the script is not executable — run it with the interpreter
 *   declared by its shebang (never force `sh` on a bash script).
 *
 * @param {string} scriptPath
 * @returns {'direct'|'bash'|'sh'}
 */
function resolveSetupInterpreter(scriptPath) {
  try {
    const stat = fs.statSync(scriptPath);
    if ((stat.mode & 0o111) !== 0) return 'direct';
    return detectSetupInterpreter(fs.readFileSync(scriptPath, 'utf8'));
  } catch (_) {
    return 'sh';
  }
}

/**
 * Runs the global setup script inside the container (once per container).
 *
 * The script is passed inline (base64) so no extra mount is needed and the
 * stdin of `podman exec` stays untouched. A failing setup never breaks the
 * container: the failure is returned so it can be recorded and surfaced
 * without flooding the stderr of every command.
 *
 * @param {string} name - Container name.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, log: string|null, exitCode: number}>}
 */
async function runGlobalSetupScript(name, options = {}) {
  const config = getSandboxConfig();
  if (!config.globalSetupEnabled) return { ok: true, log: null, exitCode: 0 };

  // The default script is written on demand, so the setup also works when the
  // server was not restarted after the feature was enabled.
  ensureGlobalSetupScript();

  const scriptPath = config.globalSetupScript;
  if (!fs.existsSync(scriptPath)) {
    console.warn(`[podmanExecutor] Global setup script not found: ${scriptPath}`);
    return { ok: true, log: null, exitCode: 0 };
  }

  const script = fs.readFileSync(scriptPath, 'utf8');
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const env = buildContainerEnv({});
  // The script is piped into the interpreter, so the shebang is only a hint.
  const interpreter = detectSetupInterpreter(script);
  const guard = interpreter === 'bash'
    ? 'command -v bash >/dev/null 2>&1 || { echo "[setup:global] FAILED: bash not found" >&2; exit 127; }; '
    : '';
  const command = `${guard}printf %s ${shellQuote(encoded)} | base64 -d | ${interpreter}`;

  const timeoutMs = options.timeoutMs || config.setupTimeoutMs;
  const result = await runPodmanProcess(buildExecArgs({ name, env, command, user: 'root' }), timeoutMs);
  const output = [
    result.stdout ? String(result.stdout).trim() : '',
    result.stderr ? String(result.stderr).trim() : '',
  ].filter(Boolean).join('\n');

  if (result.exitCode === 0) {
    // Mark the setup as done so a restart does not run it again.
    runPodmanSync([
      'exec', name, '/bin/sh', '-c',
      `mkdir -p ${shellQuote(path.dirname(config.globalSetupMarkerPath))} && touch ${shellQuote(config.globalSetupMarkerPath)}`,
    ], { timeoutMs: 20000 });
    return { ok: true, log: output ? `[setup:global] ${output}` : null, exitCode: 0 };
  }

  return {
    ok: false,
    log: `[setup:global] FAILED (exit ${result.exitCode})\n${output}`.trim(),
    exitCode: result.exitCode,
  };
}

/**
 * Runs the repository setup script inside the container (once).
 * A failing setup script never breaks the container: the failure is returned
 * and recorded, and it is not retried on every command.
 *
 * @param {string} name - Container name.
 * @param {string} worktreePath
 * @param {{timeoutMs?: number, env?: Object}} [options]
 * @returns {Promise<{ok: boolean, log: string|null, exitCode: number}>}
 */
async function runSetupScript(name, worktreePath, options = {}) {
  const config = getSandboxConfig();
  if (!worktreePath) return { ok: true, log: null, exitCode: 0 };

  const scriptPath = path.join(worktreePath, config.setupScript);
  if (!fs.existsSync(scriptPath)) return { ok: true, log: null, exitCode: 0 };

  const env = options.env || buildContainerEnv({ worktreePath });
  const interpreter = resolveSetupInterpreter(scriptPath);
  const relativeScript = path.isAbsolute(config.setupScript)
    ? config.setupScript
    : `./${config.setupScript}`;

  let invoke;
  if (interpreter === 'direct') {
    invoke = shellQuote(relativeScript);
  } else if (interpreter === 'bash') {
    invoke = [
      'command -v bash >/dev/null 2>&1 || { echo "[setup] FAILED: bash not found" >&2; exit 127; }',
      `bash ${shellQuote(relativeScript)}`,
    ].join('; ');
  } else {
    invoke = `sh ${shellQuote(relativeScript)}`;
  }

  const command = [
    'set -e',
    `cd ${shellQuote(worktreePath)}`,
    invoke,
  ].join('; ');

  const timeoutMs = options.timeoutMs || config.setupTimeoutMs;
  const result = await runPodmanProcess(buildExecArgs({ name, env, command, user: 'root' }), timeoutMs);
  const output = [
    result.stdout ? String(result.stdout).trim() : '',
    result.stderr ? String(result.stderr).trim() : '',
  ].filter(Boolean).join('\n');

  if (result.exitCode === 0) {
    // Mark the setup as done so a restart does not run it again.
    runPodmanSync([
      'exec', name, '/bin/sh', '-c',
      `mkdir -p ${shellQuote(path.dirname(config.setupMarkerPath))} && touch ${shellQuote(config.setupMarkerPath)}`,
    ], { timeoutMs: 20000 });
    return { ok: true, log: output ? `[setup] ${output}` : null, exitCode: 0 };
  }

  return {
    ok: false,
    log: `[setup] FAILED (exit ${result.exitCode})\n${output}`.trim(),
    exitCode: result.exitCode,
  };
}

/**
 * Pulls an image (used when the image is missing).
 * @param {string} image
 */
async function pullImage(image) {
  console.log(`[podmanExecutor] Pulling sandbox image ${image}...`);
  const result = runPodmanSync(['pull', image], { timeoutMs: 15 * 60 * 1000 });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to pull sandbox image ${image}: ${String(result.stderr || '').trim()}`);
  }
}

/**
 * True when the podman error means "the image is not available locally".
 */
function isImageMissingError(stderr) {
  const text = String(stderr || '');
  return /image not known|no such image|image .* not found|manifest unknown|unable to find/i.test(text);
}

/**
 * True when the podman error means "the container does not exist".
 */
function isContainerMissingError(stderr) {
  const text = String(stderr || '');
  return /no such container|no such object|container .* not found|cannot find container/i.test(text);
}

/**
 * True when podman refuses to exec because the container is not running.
 */
function isContainerNotRunningError(stderr) {
  const text = String(stderr || '');
  return /can only create exec sessions on running containers|container state improper|container .* is not running/i.test(text);
}

// ── Command execution ──────────────────────────────────────────────────────

/**
 * Quotes a string for /bin/sh.
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Raises the stack limit of a command inside the container.
 *
 * The default limit (8 MB) breaks deep recursion and some Node workloads.
 * The limit is applied with the `ulimit` builtin instead of
 * `podman create --ulimit stack=`, which makes the apt method crash with
 * SIGSEGV in rootless containers.
 *
 * @param {string} command
 * @param {string|null} [stackLimit] - Soft limit in KB (null disables it).
 * @returns {string}
 */
function buildStackLimitedCommand(command, stackLimit) {
  if (!stackLimit) return command;
  return `ulimit -s ${stackLimit} 2>/dev/null || true; ${command}`;
}

/**
 * Executes a command inside the container.
 *
 * The output is transported through files: the command writes stdout, stderr
 * and the exit code into the exchange directory (bind-mounted read-write) and
 * the host reads them back. The stream of `podman exec` is only a fallback —
 * it intermittently comes back empty, which left the assistant blind.
 *
 * @param {string} name - Container name.
 * @param {string} command
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {Object} env
 * @param {string|null} [timeoutBinary] - Path of the `timeout` binary inside the container.
 * @param {Object} [options]
 * @param {string} [options.ioDir] - Host directory of the output exchange.
 * @param {string} [options.ioTarget] - Mount point of the exchange inside the container.
 * @param {'file'|'stream'} [options.captureMode] - 'stream' disables the file capture.
 * @param {string} [options.stackLimit] - Soft stack limit (in KB) of the command.
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, failed: boolean, timedOut: boolean, captureSource: string}>}
 */
async function execInContainer(name, command, cwd, timeoutMs, env, timeoutBinary, options = {}) {
  const {
    ioDir = null,
    ioTarget = null,
    captureMode = 'file',
    stackLimit = null,
  } = options;

  // The stack limit is raised inside the container: the default (8 MB) breaks
  // deep recursion and some Node workloads. It is applied with the `ulimit`
  // builtin instead of `podman create --ulimit`, which makes the apt method
  // crash with SIGSEGV in rootless containers.
  const prepared = buildStackLimitedCommand(command, stackLimit);

  let inner = prepared;
  if (timeoutMs > 0 && timeoutBinary) {
    // The timeout is enforced INSIDE the container so the process is really killed.
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    inner = `${timeoutBinary} -k 5 ${seconds} /bin/sh -c ${shellQuote(prepared)}`;
  }

  const useFileCapture = captureMode === 'file' && Boolean(ioDir && ioTarget);
  const id = useFileCapture ? buildCaptureId() : null;

  if (useFileCapture) {
    // The sentinel proves to the container that the exchange directory is
    // really mounted — otherwise the output would be redirected into the
    // container's own filesystem and lost.
    try {
      fs.writeFileSync(path.join(ioDir, `${id}${CAPTURE_PROBE_SUFFIX}`), '', { mode: 0o600 });
    } catch (err) {
      console.warn(`[podmanExecutor] Could not create the capture sentinel: ${err && err.message ? err.message : err}`);
    }
  }

  const effective = useFileCapture ? buildCaptureCommand(inner, { ioTarget, id }) : inner;

  const args = buildExecArgs({ name, cwd, env, command: effective });
  const result = await runPodmanProcess(args, timeoutMs > 0 ? timeoutMs + 10000 : 0);

  if (isContainerMissingError(String(result.stderr || ''))) {
    throw new Error(`Sandbox container ${name} is missing`);
  }
  if (isContainerNotRunningError(String(result.stderr || ''))) {
    throw new Error(`Sandbox container ${name} is not running`);
  }

  // The `podman exec` stream intermittently closes before the inner command
  // finishes. When the stream is empty and the exit-code file is not written
  // yet, wait a bounded amount of time for the capture files before deciding
  // the fallback — otherwise the single-shot read would fall back to the empty
  // stream and the cleanup below would delete the output being written late.
  // Never wait when the exec was killed (timedOut): the whole process group
  // is gone, so the files will not appear and the wait would be pure latency.
  if (useFileCapture) {
    const hasStreamContent =
      String(result.stdout || '').trim() !== '' || String(result.stderr || '').trim() !== '';
    if (!hasStreamContent && !result.timedOut) {
      const waitMs = timeoutMs > 0 ? Math.min(timeoutMs, CAPTURE_WAIT_MS) : CAPTURE_WAIT_MS;
      await waitForCapture(ioDir, id, waitMs);
    }
  }

  const resolved = resolveCapturedResult({
    mode: useFileCapture ? 'file' : 'stream',
    ioDir,
    id,
    stream: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
    timedOut: result.timedOut,
  });

  // The cleanup only happens after the wait and the fallback decision, so the
  // files are not destroyed while the inner command is still writing them.
  if (useFileCapture) cleanupCaptureFiles(ioDir, id);

  const timedOut = resolved.timedOut;
  const timeoutMsg = timedOut ? `Command timed out after ${timeoutMs}ms` : '';

  return {
    stdout: resolved.stdout,
    stderr: [resolved.stderr, timeoutMsg].filter(Boolean).join('\n'),
    exitCode: resolved.exitCode,
    failed: resolved.exitCode !== 0,
    timedOut,
    captureSource: resolved.captureSource,
  };
}

/**
 * Runs a command in the sandbox container of a conversation.
 * Same contract as `runShellCommand` (bwrap).
 *
 * @param {string} command
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {Object} sandboxOpts
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, failed: boolean}>}
 */
async function runPodmanCommand(command, cwd = '.', timeoutMs = 0, sandboxOpts = {}) {
  const {
    repoRoot,
    worktreePath,
    readOnlyWorktree = false,
    extraPaths = [],
    exportPaths = [],
    configuredPaths = [],
    conversationId,
    projectId = null,
    image = null,
    basePath = null,
    forceSetup = false,
    captureMode = 'file',
  } = sandboxOpts;

  if (!repoRoot || !worktreePath) {
    throw new Error('[podmanExecutor] Sandbox requires repoRoot and worktreePath');
  }

  const resolvedWorktreePath = path.resolve(worktreePath);
  const resolvedCwd = path.resolve(cwd);

  const relative = path.relative(resolvedWorktreePath, resolvedCwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[podmanExecutor] cwd "${resolvedCwd}" is outside worktree "${resolvedWorktreePath}"`);
  }

  const containerId = conversationId != null ? conversationId : `cwd-${resolvedCwd}`;
  const config = getSandboxConfig();
  // The exchange directory is per conversation: the container is per
  // conversation too, so the mount point is stable.
  const ioDir = getSandboxIoDir(getSandboxIoKey(conversationId, resolvedCwd));
  const ioTarget = config.ioMountTarget;
  const stackLimit = getSandboxStackLimit(config);

  const containerParams = {
    conversationId: containerId,
    repoRoot,
    worktreePath: resolvedWorktreePath,
    readOnlyWorktree,
    extraPaths,
    exportPaths,
    configuredPaths,
    ioDir,
    ioTarget,
    projectId,
    image,
    basePath,
    forceSetup,
  };

  let ensured = await ensureContainer(containerParams);

  console.log('[podmanExecutor] Running command in sandbox', {
    container: ensured.name,
    cwd: resolvedCwd,
    command: String(command).slice(0, 100),
  });

  const execOnce = async () => {
    const state = containerStates.get(String(containerId));
    const env = state?.env || buildContainerEnv({ exportPaths, configuredPaths, worktreePath: resolvedWorktreePath, basePath });
    return execInContainer(
      ensured.name,
      command,
      resolvedCwd,
      timeoutMs,
      env,
      state?.timeoutBinary || null,
      {
        ioDir: state?.ioDir || ioDir,
        ioTarget: state?.ioTarget || ioTarget,
        captureMode,
        stackLimit,
      }
    );
  };

  let result;
  try {
    result = await execOnce();
  } catch (err) {
    const message = String(err?.message || err);
    if (!/is missing|is not running/i.test(message)) throw err;
    // Podman can lose the container between the create/start and the exec
    // (a stale state after `rm -f` + `create` with the same name). Ensure it
    // once more and retry, instead of failing the user's command.
    console.warn(`[podmanExecutor] ${message} — recreating and retrying once`);
    ensured = await ensureContainer(containerParams);
    result = await execOnce();
  }

  const { name, setup } = ensured;
  lastActivity.set(name, Date.now());

  // The setup status is a separate field: the full log belongs to the container
  // state/UI, not to the stderr of every command (it used to flood the result
  // and hide the real output).
  if (setup) result.setup = setup;

  return result;
}

// ── Idle stop / restart and orphan cleanup (B7/B8) ────────────────────────

/**
 * Lists the containers created by MiniBoss.
 * @returns {Array<{name: string, status: string, conversationId: string|null, worktree: string|null, createdAt: string|null, golden: boolean, projectId: string|null}>}
 */
function listMiniBossContainers() {
  const config = getSandboxConfig();
  const result = runPodmanSync([
    'ps', '-a',
    '--filter', `label=${config.label}=${config.labelValue}`,
    '--format', '{{.Names}}|{{.State}}|{{.CreatedAt}}',
  ], { timeoutMs: 30000 });

  if (result.exitCode !== 0) return [];

  const containers = [];
  for (const line of String(result.stdout || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, status, createdAt] = trimmed.split('|');
    if (!name) continue;
    const details = inspectLabels(name);
    containers.push({
      name,
      status: status || '',
      createdAt: createdAt || null,
      conversationId: details.conversationId,
      worktree: details.worktree,
      golden: details.golden,
      projectId: details.projectId,
    });
  }
  return containers;
}

/**
 * Reads the MiniBoss labels of a container.
 */
function inspectLabels(name) {
  const result = runPodmanSync([
    'inspect', name,
    '--format',
    [
      '{{index .Config.Labels "miniboss.conversation"}}',
      '{{index .Config.Labels "miniboss.worktree"}}',
      '{{index .Config.Labels "miniboss.golden"}}',
      '{{index .Config.Labels "miniboss.project"}}',
    ].join('|'),
  ], { timeoutMs: 20000 });

  if (result.exitCode !== 0) {
    return { conversationId: null, worktree: null, golden: false, projectId: null };
  }
  const [conversationId, worktree, golden, projectId] = String(result.stdout || '').trim().split('|');
  return {
    conversationId: conversationId && conversationId !== '' ? conversationId : null,
    worktree: worktree && worktree !== '' ? worktree : null,
    golden: golden === 'true',
    projectId: projectId && projectId !== '' ? projectId : null,
  };
}

/**
 * Stops the containers that have been idle for longer than the TTL.
 * `podman stop` keeps the writable layer, so the npm cache and the setup survive.
 *
 * @param {number} [idleTtlMs]
 * @returns {Array<string>} The names of the stopped containers.
 */
function stopIdleContainers(idleTtlMs) {
  const config = getSandboxConfig();
  const ttl = idleTtlMs || config.idleTtlMs;
  const now = Date.now();
  const stopped = [];

  for (const container of listMiniBossContainers()) {
    if (container.status !== 'running' && container.status !== 'exited') continue;
    const activity = lastActivity.get(container.name);
    const created = container.createdAt ? Date.parse(container.createdAt) : null;
    const reference = activity ?? created;
    if (reference == null || !Number.isFinite(reference)) continue;
    if (now - reference < ttl) continue;

    const result = runPodmanSync(['stop', container.name], { timeoutMs: 60000 });
    if (result.exitCode === 0) {
      console.log(`[podmanExecutor] Stopped idle container ${container.name}`);
      stopped.push(container.name);
    }
  }

  return stopped;
}

/**
 * Removes the output exchange directory of a conversation.
 * @param {number|string} conversationId
 * @returns {boolean}
 */
function removeIoDir(conversationId) {
  if (conversationId == null) return false;
  const config = getSandboxConfig();
  const key = getSandboxIoKey(conversationId);
  const dir = path.join(config.ioDir, key);
  try {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.warn(`[podmanExecutor] Could not remove the sandbox I/O directory ${dir}: ${err && err.message ? err.message : err}`);
    return false;
  }
}

/**
 * Removes the containers whose conversation no longer exists or whose worktree
 * is gone. Containers without the `miniboss=true` label are never touched.
 *
 * @param {(conversationId: string) => boolean} conversationExists
 * @returns {Array<string>} The names of the removed containers.
 */
function removeOrphanContainers(conversationExists) {
  const removed = [];

  for (const container of listMiniBossContainers()) {
    // The golden container of a project is never an orphan: it is owned by the
    // project, not by a conversation, and the user manages it explicitly.
    if (container.golden) continue;
    const conversationId = container.conversationId;
    const worktree = container.worktree;

    const conversationGone = conversationId ? !conversationExists(conversationId) : false;
    const worktreeGone = worktree ? !fs.existsSync(worktree) : false;

    if (!conversationGone && !worktreeGone) continue;

    const result = runPodmanSync(['rm', '-f', container.name], { timeoutMs: 60000 });
    if (result.exitCode === 0) {
      console.log(`[podmanExecutor] Removed orphan container ${container.name}`);
      removed.push(container.name);
      if (conversationGone && conversationId) removeIoDir(conversationId);
    }
  }

  return removed;
}

/**
 * Removes the container of a conversation (called when the conversation is deleted).
 * @param {number|string} conversationId
 */
function removeContainerForConversation(conversationId) {
  if (conversationId == null) return false;
  const name = containerNameFor(conversationId);
  const result = runPodmanSync(['rm', '-f', name], { timeoutMs: 60000 });
  containerStates.delete(String(conversationId));
  lastActivity.delete(name);
  removeIoDir(conversationId);
  return result.exitCode === 0;
}

/**
 * Name of the golden container of a project.
 * @param {number|string} projectId
 * @returns {string}
 */
function goldenContainerNameFor(projectId) {
  const key = String(projectId == null ? '' : projectId).replace(/[^A-Za-z0-9_-]/g, '_');
  return `miniboss-proj-${key || 'unknown'}`;
}

/**
 * Ensures the golden container of a project exists and is running.
 *
 * The golden container is a per-project console the user enters from the host
 * (`podman exec -it --user root <name> bash`) to install what the project needs. It mounts
 * the repository read-write and the project cache, and is committed into the
 * project image by `commitGoldenContainer`.
 *
 * @param {Object} params
 * @param {number|string} params.projectId
 * @param {string} params.repoRoot
 * @param {string} [params.image]
 * @param {string} [params.basePath] - PATH captured from a previous commit.
 * @returns {{name: string, created: boolean, started: boolean, running: boolean}}
 */
function ensureGoldenContainer(params = {}) {
  const { projectId, repoRoot } = params;
  if (!repoRoot) throw new Error('[podmanExecutor] The golden container requires the project folder');

  const config = getSandboxConfig();
  const image = resolveSandboxImage(params.image);
  const cacheDir = getProjectSandboxCacheDir(projectId);
  const name = goldenContainerNameFor(projectId);

  const mounts = buildMountMap({ worktreePath: repoRoot, cacheDir });
  const mountsKey = buildMountsKey(mounts);
  const env = buildContainerEnv({ worktreePath: repoRoot, basePath: params.basePath });
  const pathKey = buildPathKey(env.PATH);
  const labels = {
    [config.label]: config.labelValue,
    'miniboss.golden': 'true',
    'miniboss.project': String(projectId),
    'miniboss.worktree': repoRoot,
    'miniboss.mounts': mountsKey,
    'miniboss.image': image,
    'miniboss.spec': CONTAINER_SPEC_VERSION,
    'miniboss.path': pathKey,
  };

  const info = inspectContainer(name);
  let created = false;
  let started = false;

  const recreateReasons = containerRecreateReasons(info, {
    mountsKey,
    image,
    spec: CONTAINER_SPEC_VERSION,
    pathKey,
  });

  if (info && recreateReasons.length > 0) {
    console.log(`[podmanExecutor] Recreating golden container ${name} (${recreateReasons.join(', ')})`);
    runPodmanSync(['rm', '-f', name], { timeoutMs: 30000 });
  }

  if (!info || recreateReasons.length > 0) {
    const createArgs = buildCreateArgs({
      name,
      image,
      mounts,
      env,
      labels,
      workdir: repoRoot,
      network: config.network,
    });
    const createdResult = runPodmanSync(createArgs, { timeoutMs: 10 * 60 * 1000 });
    if (createdResult.exitCode !== 0) {
      const stderr = String(createdResult.stderr || '').trim();
      if (isImageMissingError(stderr)) {
        pullImageSync(image);
        const retry = runPodmanSync(createArgs, { timeoutMs: 10 * 60 * 1000 });
        if (retry.exitCode !== 0) {
          throw new Error(`Failed to create the golden container: ${String(retry.stderr || retry.stdout).trim()}`);
        }
      } else {
        throw new Error(
          `Failed to create the golden container: ${stderr || createdResult.stdout || `exit code ${createdResult.exitCode}`}`
        );
      }
    }
    created = true;
  }

  const state = inspectContainer(name);
  if (state && !state.running) {
    const startResult = runPodmanSync(['start', name], { timeoutMs: 60000 });
    if (startResult.exitCode !== 0) {
      throw new Error(`Failed to start the golden container: ${String(startResult.stderr || '').trim()}`);
    }
    started = true;
  }

  prepareContainer(name, env, null).catch((err) => {
    console.warn(`[podmanExecutor] Could not prepare the golden container ${name}: ${err?.message || err}`);
  });

  lastActivity.set(name, Date.now());
  return { name, created, started, running: true };
}

/**
 * Pulls an image synchronously (used by the golden container helpers).
 * @param {string} image
 */
function pullImageSync(image) {
  console.log(`[podmanExecutor] Pulling sandbox image ${image}...`);
  const result = runPodmanSync(['pull', image], { timeoutMs: 15 * 60 * 1000 });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to pull sandbox image ${image}: ${String(result.stderr || '').trim()}`);
  }
}

/**
 * Status of the golden container of a project.
 * @param {number|string} projectId
 * @returns {{name: string, exists: boolean, running: boolean, status: string|null, image: string|null}}
 */
function getGoldenContainerStatus(projectId) {
  const name = goldenContainerNameFor(projectId);
  const info = inspectContainer(name);
  return {
    name,
    exists: Boolean(info),
    running: Boolean(info && info.running),
    status: info ? info.status : null,
    image: info ? info.image : null,
  };
}

/**
 * Reads the PATH a login shell sees inside a running container.
 *
 * `podman commit` does not persist an interactive `export PATH=…`; only what a
 * profile file defines survives. Capturing the login-shell PATH at commit time
 * gives the conversations the same base PATH as the golden console.
 *
 * A login shell is used (`bash -lc`, falling back to `sh -lc` because Debian's
 * `sh` is dash and does not read `/etc/profile.d`). Profile output may pollute
 * stdout, so only the last non-empty line is taken and it must look like a PATH.
 *
 * @param {string} name - Container name (must be running).
 * @param {Function} [runner] - Injection point for tests (defaults to runPodmanSync).
 * @returns {string|null} The captured PATH, or null on any failure.
 */
function captureGoldenPath(name, runner = runPodmanSync) {
  if (!name) return null;
  const command = 'if command -v bash >/dev/null 2>&1; then exec bash -lc \'printf "%s\\n" "$PATH"\'; fi; exec sh -lc \'printf "%s\\n" "$PATH"\'';
  const result = runner(
    ['exec', '--user', 'root', name, '/bin/sh', '-c', command],
    { timeoutMs: 30000 }
  );

  // Exit code, never stdout, decides success.
  if (!result || result.exitCode !== 0) return null;

  const lines = String(result.stdout || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const captured = lines.length > 0 ? lines[lines.length - 1] : '';
  if (!captured || !captured.includes('/')) return null;
  return captured;
}

/**
 * Commits the golden container into the project image.
 *
 * The container is stopped before the commit (a running container can be
 * captured in an inconsistent state) and started again afterwards. Bind mounts
 * (the repository and the cache) are not captured, which is intended.
 *
 * @param {number|string} projectId
 * @returns {{ref: string, path: string|null}} The image reference that was
 *   created and the PATH captured from the login shell (null when unavailable).
 */
function commitGoldenContainer(projectId) {
  const name = goldenContainerNameFor(projectId);
  const info = inspectContainer(name);
  if (!info) {
    throw new Error(`The golden container ${name} does not exist`);
  }

  // Capture before the stop: `podman exec` does not work on a stopped container.
  const path = info.running ? captureGoldenPath(name) : null;

  runPodmanSync(['stop', name], { timeoutMs: 120000 });
  const ref = `localhost/miniboss/proj-${projectId}:${Date.now()}`;
  const result = runPodmanSync(['commit', name, ref], { timeoutMs: 10 * 60 * 1000 });
  if (result.exitCode !== 0) {
    // Bring the console back even when the commit fails.
    runPodmanSync(['start', name], { timeoutMs: 60000 });
    throw new Error(`Failed to commit the golden container: ${String(result.stderr || '').trim()}`);
  }
  runPodmanSync(['start', name], { timeoutMs: 60000 });
  lastActivity.set(name, Date.now());
  return { ref, path };
}

/**
 * Removes the golden container so it is recreated from the base image.
 * @param {number|string} projectId
 * @param {Object} params - `repoRoot` and optional `image` of the project.
 * @returns {{name: string, created: boolean, started: boolean, running: boolean}}
 */
function resetGoldenContainer(projectId, params = {}) {
  const name = goldenContainerNameFor(projectId);
  runPodmanSync(['rm', '-f', name], { timeoutMs: 60000 });
  lastActivity.delete(name);
  return ensureGoldenContainer({ projectId, ...params });
}

module.exports = {
  CONTAINER_SPEC_VERSION,
  CONTAINER_CAPABILITIES,
  DEFAULT_GLOBAL_SETUP_SCRIPT,
  MAX_CAPTURE_BYTES,
  buildMountMap,
  buildMountsKey,
  buildContainerEnv,
  buildPathKey,
  buildCreateArgs,
  buildExecArgs,
  buildCaptureCommand,
  buildCaptureId,
  buildStackLimitedCommand,
  resolveSetupInterpreter,
  detectSetupInterpreter,
  isSetupDone,
  detectTimeoutBinary,
  shouldRetrySetup,
  resolveCapturedResult,
  waitForCapture,
  getCaptureStats,
  containerNameFor,
  inspectContainer,
  containerRecreateReasons,
  ensureContainer,
  prepareContainer,
  execInContainer,
  runPodmanCommand,
  ensureGlobalSetupScript,
  runGlobalSetupScript,
  runSetupScript,
  listMiniBossContainers,
  stopIdleContainers,
  removeOrphanContainers,
  removeContainerForConversation,
  removeIoDir,
  goldenContainerNameFor,
  ensureGoldenContainer,
  getGoldenContainerStatus,
  captureGoldenPath,
  commitGoldenContainer,
  resetGoldenContainer,
  isImageMissingError,
  isContainerMissingError,
  isContainerNotRunningError,
  hasNewuidmap,
};
