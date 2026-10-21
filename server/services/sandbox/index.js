const { getSandboxRuntime, getSandboxConfig, resolvePodmanBinary, buildPodmanEnv, hasNewuidmap } = require('./runtime');

/**
 * Sandbox facade.
 *
 * Exposes a single entry point (`runSandboxCommand`) used by the tool processor,
 * so the runtime (podman or bwrap) is a deployment decision, not a code change.
 */

let sweeperTimer = null;

/**
 * Runs a command inside the sandbox.
 *
 * @param {string} command
 * @param {string} cwd
 * @param {number} timeoutMs
 * @param {Object} sandboxOpts - { repoRoot, worktreePath, readOnlyWorktree, extraPaths, exportPaths, configuredPaths, conversationId }
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number, failed: boolean}>}
 */
async function runSandboxCommand(command, cwd, timeoutMs, sandboxOpts = {}) {
  if (getSandboxRuntime() === 'bwrap') {
    const { runShellCommand } = require('../shellExecutor');
    return runShellCommand(command, cwd, timeoutMs, sandboxOpts);
  }

  const { runPodmanCommand } = require('./podmanExecutor');
  return runPodmanCommand(command, cwd, timeoutMs, sandboxOpts);
}

/**
 * Runs a podman command with a hard timeout.
 * The child is killed with SIGKILL when the timeout expires — podman can block
 * for a long time (waiting on D-Bus/logind, for example) and would ignore
 * SIGTERM, hanging the server.
 *
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {{ok: boolean, status: number|null, stdout: string, stderr: string, timedOut: boolean}}
 */
function runPodman(args, timeoutMs = 30000) {
  const { spawnSync } = require('child_process');
  const { resolvePodmanBinary, buildPodmanEnv } = require('./runtime');

  const result = spawnSync(resolvePodmanBinary(), args, {
    env: buildPodmanEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  });

  const timedOut = Boolean(result.error && /ETIMEDOUT/i.test(String(result.error.message || '')));
  return {
    ok: !result.error && result.status === 0,
    status: typeof result.status === 'number' ? result.status : null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    timedOut,
  };
}

/**
 * Verifies that the configured sandbox runtime is usable.
 * Throws an Error with an actionable message when it is not.
 *
 * @returns {Promise<{runtime: string, image: string, ready: boolean}>}
 */
async function checkSandboxRuntime() {
  const config = getSandboxConfig();

  if (config.runtime === 'bwrap') {
    const { execFileSync } = require('child_process');
    try {
      execFileSync('which', ['bwrap'], { stdio: 'ignore' });
    } catch (_) {
      throw new Error(
        'Sandbox runtime "bwrap" is selected but bubblewrap is not installed. ' +
        'Install it (apt-get install bubblewrap) or set SANDBOX_RUNTIME=podman.'
      );
    }
    console.log('[Startup] Sandbox runtime: bwrap (bubblewrap)');
    return { runtime: 'bwrap', image: null, ready: true };
  }

  // ── podman ──────────────────────────────────────────────────────────────
  const binary = resolvePodmanBinary();

  const version = runPodman(['--version'], 20000);
  if (!version.ok) {
    throw new Error(
      `Sandbox runtime "podman" is selected but the podman binary is not usable (${binary}).\n` +
      'Install rootless podman (apt-get install podman) or set SANDBOX_RUNTIME=bwrap.'
    );
  }

  // `podman info` is the canonical check, but it can block on a broken D-Bus/logind
  // on some hosts — fall back to a lighter probe that still proves the storage works.
  const info = runPodman(['info', '--format', '{{.Host.Security.Rootless}}'], 30000);
  if (!info.ok) {
    const ps = runPodman(['ps', '-a'], 20000);
    if (!ps.ok) {
      throw new Error(
        'Rootless podman is not working on this host (podman info and podman ps both failed).\n' +
        'Check `podman info` and, on Debian/Ubuntu, install the `uidmap` package ' +
        '(newuidmap/newgidmap) plus `slirp4netns` or `pasta` for rootless networking.'
      );
    }
    console.warn(
      `[Startup] WARNING: \`podman info\` did not answer (${info.timedOut ? 'timed out' : (info.stderr.trim() || 'failed')}) — ` +
      'falling back to a lighter check. The sandbox may still work.'
    );
  }

  if (!hasNewuidmap()) {
    console.warn(
      '[Startup] WARNING: newuidmap/newgidmap not found — podman will use a single-UID mapping. ' +
      'Install the `uidmap` package for the full rootless UID range.'
    );
  }

  // Make sure the image is available (pull it when missing).
  const imageExists = runPodman(['image', 'exists', config.image], 60000);
  if (!imageExists.ok) {
    console.log(`[Startup] Pulling sandbox image ${config.image} (this can take a few minutes)...`);
    const pull = runPodman(['pull', config.image], 15 * 60 * 1000);
    if (!pull.ok) {
      throw new Error(
        `Could not pull the sandbox image ${config.image}. Run \`podman pull ${config.image}\` manually ` +
        'or set SANDBOX_IMAGE to an image available on this host.'
      );
    }
  }

  console.log(`[Startup] Sandbox runtime: podman (${binary}) — image ${config.image}`);
  return { runtime: 'podman', image: config.image, ready: true };
}

/**
 * Starts the idle sweeper: stops the containers that have been idle for longer
 * than the TTL and removes the orphans. Never throws.
 *
 * @param {{intervalMs?: number}} [options]
 */
function startSandboxSweeper(options = {}) {
  const config = getSandboxConfig();
  if (config.runtime !== 'podman') return null;
  if (sweeperTimer) return sweeperTimer;

  const intervalMs = options.intervalMs || 60 * 1000;

  sweeperTimer = setInterval(() => {
    try {
      const { stopIdleContainers, removeOrphanContainers } = require('./podmanExecutor');
      stopIdleContainers(config.idleTtlMs);
      removeOrphanContainers(conversationExists);
    } catch (err) {
      console.warn('[sandbox] Sweeper failed:', err?.message || err);
    }
  }, intervalMs);

  if (typeof sweeperTimer.unref === 'function') sweeperTimer.unref();
  return sweeperTimer;
}

/**
 * Stops the sandbox sweeper.
 */
function stopSandboxSweeper() {
  if (sweeperTimer) {
    clearInterval(sweeperTimer);
    sweeperTimer = null;
  }
}

/**
 * Whether a conversation still exists (used by the orphan cleanup).
 * @param {string} conversationId
 * @returns {boolean}
 */
function conversationExists(conversationId) {
  const id = Number(conversationId);
  // A container whose label is not a conversation id can never match a row.
  if (!Number.isFinite(id)) return false;

  try {
    const { DatabaseAPI, DatabaseConnection } = require('../db');
    const connection = new DatabaseConnection();
    try {
      const db = new DatabaseAPI(connection);
      return Boolean(db.getConversation(id));
    } finally {
      connection.close();
    }
  } catch (_) {
    // If the DB cannot be reached, never delete a container.
    return true;
  }
}

module.exports = {
  runSandboxCommand,
  checkSandboxRuntime,
  startSandboxSweeper,
  stopSandboxSweeper,
  conversationExists,
};
