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
const CONTAINER_SPEC_VERSION = '3';

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
 * Builds the environment allowlist passed to the container (decision D7).
 *
 * @param {Object} params
 * @param {Array<string>} [params.exportPaths] - Sandbox paths exported to PATH.
 * @param {Array<string>} [params.configuredPaths] - Every configured sandbox path.
 * @returns {Object}
 */
function buildContainerEnv(params = {}) {
  const config = getSandboxConfig();
  const exportPaths = (params.exportPaths || []).filter(Boolean);
  const configured = new Set((params.configuredPaths || []).filter(Boolean).map(p => path.resolve(p)));

  const imagePath = config.containerPath
    .split(':')
    .filter(Boolean)
    // A configured path that is NOT exported is removed from PATH.
    .filter(p => !configured.has(path.resolve(p)) || exportPaths.includes(p));

  const merged = [...imagePath];
  for (const p of exportPaths) {
    if (p && !merged.includes(p)) merged.push(p);
  }

  return {
    HOME: config.containerHome,
    PATH: merged.join(':'),
    LANG: process.env.LANG || 'C.UTF-8',
    TZ: process.env.TZ || 'UTC',
    CI: '1',
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

/** Diagnostics of the output transport (file / fallback / divergence). */
const captureStats = { file: 0, fallback: 0, divergence: 0 };

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
      // No exit code file: the capture did not happen.
      captureStats.fallback += 1;
      stderr = [stderr, '[sandbox] output capture fell back to the exec stream'].filter(Boolean).join('\n');
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
 * @returns {{exists: boolean, running: boolean, labels: Object, mountsKey: string|null}|null}
 */
function inspectContainer(name) {
  const result = runPodmanSync([
    'inspect', name,
    '--format', '{{.State.Status}}|{{index .Config.Labels "miniboss.mounts"}}',
  ], { timeoutMs: 20000 });

  if (result.exitCode !== 0) return null;

  const [status, mountsKey] = String(result.stdout || '').trim().split('|');
  return {
    exists: true,
    running: status === 'running',
    status,
    mountsKey: mountsKey && mountsKey !== '' ? mountsKey : null,
  };
}

/**
 * Ensures the container for a conversation exists, is running and has the
 * expected mount map. Recreates it when the mounts changed (the mount map is
 * fixed at `create` time).
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
 * @returns {Promise<{name: string, created: boolean, started: boolean, setupLog: string|null}>}
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
  } = params;

  const name = containerNameFor(conversationId);
  const mounts = buildMountMap({ repoRoot, worktreePath, readOnlyWorktree, extraPaths, ioDir, ioTarget });
  const mountsKey = buildMountsKey(mounts);

  const env = buildContainerEnv({ exportPaths, configuredPaths });
  const labels = {
    [config.label]: config.labelValue,
    'miniboss.conversation': String(conversationId),
    'miniboss.worktree': worktreePath || repoRoot || '',
    'miniboss.mounts': mountsKey,
  };

  const info = inspectContainer(name);
  let created = false;
  let started = false;

  if (info && info.mountsKey && info.mountsKey !== mountsKey) {
    // The mount map is fixed at create time — the container must be recreated.
    console.log(`[podmanExecutor] Recreating container ${name} (mount map changed)`);
    runPodmanSync(['rm', '-f', name], { timeoutMs: 30000 });
    containerStates.delete(String(conversationId));
  }

  if (!info || info.mountsKey !== mountsKey) {
    const createArgs = buildCreateArgs({
      name,
      image: config.image,
      mounts,
      env,
      labels,
      workdir: worktreePath || repoRoot,
      network: config.network,
    });
    const created_result = runPodmanSync(createArgs, { timeoutMs: 10 * 60 * 1000 });
    if (created_result.exitCode !== 0) {
      const stderr = String(created_result.stderr || '').trim();
      if (isImageMissingError(stderr)) {
        await pullImage(config.image);
        const retry = runPodmanSync(createArgs, { timeoutMs: 10 * 60 * 1000 });
        if (retry.exitCode !== 0) {
          throw new Error(`Failed to create sandbox container: ${String(retry.stderr || retry.stdout).trim()}`);
        }
      } else {
        throw new Error(
          `Failed to create sandbox container: ${stderr || created_result.stdout || `exit code ${created_result.exitCode}`}`
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

  // Prepare the container HOME (the npm cache lives there), the output
  // exchange directory and detect the in-container timeout binary.
  const prepared = await prepareContainer(name, env, ioTarget);

  // Run the global setup script (CLI tools) and the repository setup script,
  // each of them exactly once per container.
  let setupLog = null;
  if (!prepared.globalSetupDone) {
    setupLog = await runGlobalSetupScript(name);
  }
  if (!prepared.setupDone) {
    const repoSetupLog = await runSetupScript(name, worktreePath || repoRoot);
    setupLog = [setupLog, repoSetupLog].filter(Boolean).join('\n');
  }

  containerStates.set(String(conversationId), {
    name,
    mountsKey,
    env,
    setupLog,
    timeoutBinary: prepared.timeoutBinary,
    ioDir,
    ioTarget,
  });

  lastActivity.set(name, Date.now());

  return { name, created, started, setupLog };
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
  parts.push('command -v timeout || true');

  // Runs as the container root: the container root is mapped to the host user
  // (keep-id), so the HOME directory belongs to the user and not to root.
  const result = await runPodmanProcess(buildExecArgs({ name, env, command: parts.join('; '), user: 'root' }), 30000);
  const output = `${result.stdout || ''}`.trim();
  const setupDone = await isSetupDone(name, config.setupMarkerPath);
  const globalSetupDone = await isSetupDone(name, config.globalSetupMarkerPath);
  return {
    timeoutBinary: output && output.startsWith('/') ? output : null,
    setupDone,
    globalSetupDone,
  };
}

/**
 * Whether a setup script already ran in this container.
 * @param {string} name
 * @param {string} markerPath
 */
async function isSetupDone(name, markerPath) {
  const result = runPodmanSync([
    'exec', name, '/bin/sh', '-c',
    `test -f ${shellQuote(markerPath)} && echo yes || echo no`,
  ], { timeoutMs: 20000 });
  return String(result.stdout || '').trim() === 'yes';
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
 * Runs the global setup script inside the container (once per container).
 *
 * The script is passed inline (base64) so no extra mount is needed and the
 * stdin of `podman exec` stays untouched. A failing setup never breaks the
 * container: the failure is logged and surfaced in the first `runCommand`.
 *
 * @param {string} name - Container name.
 * @returns {Promise<string|null>}
 */
async function runGlobalSetupScript(name) {
  const config = getSandboxConfig();
  if (!config.globalSetupEnabled) return null;

  // The default script is written on demand, so the setup also works when the
  // server was not restarted after the feature was enabled.
  ensureGlobalSetupScript();

  const scriptPath = config.globalSetupScript;
  if (!fs.existsSync(scriptPath)) {
    console.warn(`[podmanExecutor] Global setup script not found: ${scriptPath}`);
    return null;
  }

  const script = fs.readFileSync(scriptPath, 'utf8');
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const env = buildContainerEnv({});
  const command = `printf %s ${shellQuote(encoded)} | base64 -d | sh`;

  const result = await runPodmanProcess(buildExecArgs({ name, env, command, user: 'root' }), 10 * 60 * 1000);
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
    return output ? `[setup:global] ${output}` : null;
  }

  return `[setup:global] FAILED (exit ${result.exitCode})\n${output}`;
}

/**
 * Runs the repository setup script inside the container (once).
 * A failing setup script never breaks the container: the failure is logged and
 * the log is surfaced in the first `runCommand` result.
 */
async function runSetupScript(name, worktreePath) {
  const config = getSandboxConfig();
  if (!worktreePath) return null;

  const scriptPath = path.join(worktreePath, config.setupScript);
  if (!fs.existsSync(scriptPath)) return null;

  const env = buildContainerEnv({});
  const command = [
    'set -e',
    `cd ${shellQuote(worktreePath)}`,
    `sh ${shellQuote(config.setupScript)}`,
  ].join('; ');

  const result = await runPodmanProcess(buildExecArgs({ name, env, command, user: 'root' }), 10 * 60 * 1000);
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
    return output ? `[setup] ${output}` : null;
  }

  return `[setup] FAILED (exit ${result.exitCode})\n${output}`;
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
  return /no such container|container .* not found|cannot find container/i.test(text);
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
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, failed: boolean}>}
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

  const resolved = resolveCapturedResult({
    mode: useFileCapture ? 'file' : 'stream',
    ioDir,
    id,
    stream: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
    timedOut: result.timedOut,
  });

  if (useFileCapture) cleanupCaptureFiles(ioDir, id);

  const timedOut = resolved.timedOut;
  const timeoutMsg = timedOut ? `Command timed out after ${timeoutMs}ms` : '';

  return {
    stdout: resolved.stdout,
    stderr: [resolved.stderr, timeoutMsg].filter(Boolean).join('\n'),
    exitCode: resolved.exitCode,
    failed: resolved.exitCode !== 0,
    timedOut,
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

  const { name, setupLog } = await ensureContainer({
    conversationId: containerId,
    repoRoot,
    worktreePath: resolvedWorktreePath,
    readOnlyWorktree,
    extraPaths,
    exportPaths,
    configuredPaths,
    ioDir,
    ioTarget,
  });

  const state = containerStates.get(String(containerId));
  const env = state?.env || buildContainerEnv({ exportPaths, configuredPaths });

  console.log('[podmanExecutor] Running command in sandbox', {
    container: name,
    cwd: resolvedCwd,
    command: String(command).slice(0, 100),
  });

  const result = await execInContainer(
    name,
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

  lastActivity.set(name, Date.now());

  // The setup log is surfaced in the first command result.
  if (setupLog) {
    result.stderr = [setupLog, result.stderr].filter(Boolean).join('\n');
  }

  return result;
}

// ── Idle stop / restart and orphan cleanup (B7/B8) ────────────────────────

/**
 * Lists the containers created by MiniBoss.
 * @returns {Array<{name: string, status: string, conversationId: string|null, worktree: string|null, createdAt: string|null}>}
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
    '--format', '{{index .Config.Labels "miniboss.conversation"}}|{{index .Config.Labels "miniboss.worktree"}}',
  ], { timeoutMs: 20000 });

  if (result.exitCode !== 0) return { conversationId: null, worktree: null };
  const [conversationId, worktree] = String(result.stdout || '').trim().split('|');
  return {
    conversationId: conversationId && conversationId !== '' ? conversationId : null,
    worktree: worktree && worktree !== '' ? worktree : null,
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

module.exports = {
  CONTAINER_SPEC_VERSION,
  CONTAINER_CAPABILITIES,
  DEFAULT_GLOBAL_SETUP_SCRIPT,
  MAX_CAPTURE_BYTES,
  buildMountMap,
  buildMountsKey,
  buildContainerEnv,
  buildCreateArgs,
  buildExecArgs,
  buildCaptureCommand,
  buildCaptureId,
  buildStackLimitedCommand,
  resolveCapturedResult,
  getCaptureStats,
  containerNameFor,
  inspectContainer,
  ensureContainer,
  prepareContainer,
  execInContainer,
  runPodmanCommand,
  ensureGlobalSetupScript,
  runGlobalSetupScript,
  listMiniBossContainers,
  stopIdleContainers,
  removeOrphanContainers,
  removeContainerForConversation,
  removeIoDir,
  isImageMissingError,
  isContainerMissingError,
  hasNewuidmap,
};
