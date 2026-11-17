const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { getDataFolder } = require('../../config/paths');

/**
 * Sandbox runtime resolution.
 *
 * Two runtimes are supported (decision D6):
 *   - `podman` (default): one persistent container per conversation worktree,
 *     every command is a `podman exec`.
 *   - `bwrap`: the previous bubblewrap sandbox, kept until Podman is proven.
 *
 * The runtime is chosen by the `SANDBOX_RUNTIME` environment variable.
 */

const DEFAULT_IMAGE = 'docker.io/library/node:22-bookworm';
const DEFAULT_IDLE_TTL_MIN = 10;
const DEFAULT_CONTAINER_HOME = '/home/miniboss';
const DEFAULT_CONTAINER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const GLOBAL_SETUP_MARKER_PATH = '/var/lib/miniboss/global-setup.done';
const DEFAULT_IO_MOUNT_TARGET = '/var/lib/miniboss/io';
const DEFAULT_SHM_SIZE = '1g';
const DEFAULT_ULIMIT_STACK = '65536:65536';
const DEFAULT_SETUP_TIMEOUT_MIN = 10;
const DEFAULT_SETUP_RETRY_MIN = 5;
const DEFAULT_CACHE_SUBDIR = 'cache';
const DEFAULT_CACHE_KEY = '_default';
const IO_KEY_MAX_LENGTH = 64;
const CONTAINER_LABEL = 'miniboss';
const CONTAINER_LABEL_VALUE = 'true';

/**
 * @returns {'podman'|'bwrap'}
 */
function getSandboxRuntime() {
  const raw = String(process.env.SANDBOX_RUNTIME || '').trim().toLowerCase();
  if (raw === 'bwrap' || raw === 'bubblewrap') return 'bwrap';
  return 'podman';
}

let imageOverride = null;

/**
 * Overrides the sandbox image (e.g. from the `sandbox_image` setting).
 * @param {string|null} image
 */
function setSandboxImage(image) {
  const value = String(image || '').trim();
  imageOverride = value || null;
}

/**
 * @returns {Object} The effective sandbox configuration.
 */
function getSandboxConfig() {
  const idleTtlMin = parseInt(process.env.SANDBOX_IDLE_TTL_MIN, 10);
  const setupTimeoutMsRaw = parseInt(process.env.SANDBOX_SETUP_TIMEOUT_MS, 10);
  const setupTimeoutMin = parseInt(process.env.SANDBOX_SETUP_TIMEOUT_MIN, 10);
  const setupRetryMin = parseInt(process.env.SANDBOX_SETUP_RETRY_MIN, 10);
  return {
    runtime: getSandboxRuntime(),
    image: imageOverride || (process.env.SANDBOX_IMAGE || DEFAULT_IMAGE).trim(),
    idleTtlMs: (Number.isFinite(idleTtlMin) && idleTtlMin > 0 ? idleTtlMin : DEFAULT_IDLE_TTL_MIN) * 60 * 1000,
    containerHome: (process.env.SANDBOX_CONTAINER_HOME || DEFAULT_CONTAINER_HOME).trim(),
    containerPath: (process.env.SANDBOX_CONTAINER_PATH || DEFAULT_CONTAINER_PATH).trim(),
    // Global setup: the CLI tools the container is missing (jq, rg, sqlite3, ip…).
    // It runs once per container, as root, and is not fatal when it fails.
    globalSetupEnabled: !/^(0|false|no|off)$/i.test(String(process.env.SANDBOX_GLOBAL_SETUP || '').trim()),
    globalSetupScript: (
      process.env.SANDBOX_GLOBAL_SETUP_SCRIPT ||
      path.join(getDataFolder(), 'sandbox', 'setup.sh')
    ).trim(),
    globalSetupMarkerPath: GLOBAL_SETUP_MARKER_PATH,
    // Timeout of the global/repository setup scripts. A heavy setup must not
    // block the command forever; the failure is recorded and retried only
    // after the backoff below.
    setupTimeoutMs:
      (Number.isFinite(setupTimeoutMsRaw) && setupTimeoutMsRaw > 0
        ? setupTimeoutMsRaw
        : (Number.isFinite(setupTimeoutMin) && setupTimeoutMin > 0 ? setupTimeoutMin : DEFAULT_SETUP_TIMEOUT_MIN) * 60 * 1000),
    setupRetryMs:
      (Number.isFinite(setupRetryMin) && setupRetryMin > 0 ? setupRetryMin : DEFAULT_SETUP_RETRY_MIN) *
      60 * 1000,
    // Persistent cache shared between the conversation sandboxes of the same
    // project (Deno/npm/Playwright downloads…).
    cacheDir: (
      process.env.SANDBOX_CACHE_DIR ||
      path.join(getDataFolder(), 'sandbox', DEFAULT_CACHE_SUBDIR)
    ).trim(),
    // Output transport: the command writes stdout/stderr/exit-code into a file
    // inside the container; the host reads the files back (the exec stream is
    // only a fallback — it sometimes comes back empty).
    ioDir: (process.env.SANDBOX_IO_DIR || path.join(getDataFolder(), 'sandbox', 'io')).trim(),
    ioMountTarget: (process.env.SANDBOX_IO_MOUNT_TARGET || DEFAULT_IO_MOUNT_TARGET).trim(),
    // Container resources: /dev/shm defaults to 64 MB and the stack to 8 MB,
    // which breaks Chromium-based tools and some Node workloads.
    shmSize: (process.env.SANDBOX_SHM_SIZE || DEFAULT_SHM_SIZE).trim(),
    ulimitStack: (process.env.SANDBOX_ULIMIT_STACK || DEFAULT_ULIMIT_STACK).trim(),
    // The stack limit is applied INSIDE the command (the `ulimit` builtin):
    // passing it to `podman create` makes the apt method crash with SIGSEGV
    // in rootless containers, which would break the global setup.
    ulimitStackCreate: /^(1|true|yes|on)$/i.test(String(process.env.SANDBOX_ULIMIT_STACK_CREATE || '').trim()),
    // 'default' keeps the rootless network (slirp4netns/pasta) so `npm install` works;
    // 'none' isolates the container completely.
    network: (process.env.SANDBOX_NETWORK || 'default').trim(),
    podmanBin: (process.env.PODMAN_BIN || '').trim(),
    containersConf: (process.env.PODMAN_CONTAINERS_CONF || '').trim(),
    // User used to force the single-UID mapping when `newuidmap` is unavailable.
    rootlessUser: (process.env.PODMAN_ROOTLESS_USER || 'miniboss-podman').trim(),
    label: CONTAINER_LABEL,
    labelValue: CONTAINER_LABEL_VALUE,
  };
}

/**
 * Sanitizes a key so it can be used as a directory name.
 * @param {*} value
 * @returns {string}
 */
function sanitizeIoKey(value) {
  const sanitized = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .slice(0, IO_KEY_MAX_LENGTH);
  return sanitized || 'unknown';
}

/**
 * Key of the exchange directory of a conversation.
 *
 * The conversation id is used when there is one; the executions without a
 * conversation (the smoke test, the probe) get a `cwd-<hash>` key so the
 * directory is stable for the same working directory.
 *
 * @param {number|string|null|undefined} conversationId
 * @param {string} [cwd]
 * @returns {string}
 */
function getSandboxIoKey(conversationId, cwd) {
  if (conversationId != null && String(conversationId).trim() !== '') {
    return sanitizeIoKey(conversationId);
  }
  const hash = crypto.createHash('sha1').update(String(cwd || '')).digest('hex').slice(0, 12);
  return `cwd-${hash}`;
}

/**
 * The effective stack limit (soft limit, in KB) applied to the commands run
 * inside the container.
 *
 * The value is configured as `soft:hard` but only the soft limit is
 * effective — the hard limit cannot be raised by an unprivileged process.
 *
 * @param {Object} [config] - The sandbox configuration (read when omitted).
 * @returns {string|null} The soft limit in KB, or null when it is disabled.
 */
function getSandboxStackLimit(config) {
  const resolved = config || getSandboxConfig();
  const raw = String(resolved.ulimitStack || '').trim();
  if (!raw) return null;
  const soft = raw.split(':')[0].trim();
  if (!soft || soft === 'unlimited') return null;
  return /^\d+$/.test(soft) ? soft : null;
}

/**
 * Exchange directory of a conversation (host side).
 *
 * The directory is bind-mounted read-write inside the container: the command
 * writes its stdout/stderr/exit-code there and the host reads the files back.
 * It is created with mode 0700 — it is scratch space, never shared.
 *
 * @param {string} conversationKey
 * @returns {string} The absolute path of the directory.
 */
function getSandboxIoDir(conversationKey) {
  const config = getSandboxConfig();
  const dir = path.join(config.ioDir, sanitizeIoKey(conversationKey));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Resolves the sandbox image for a project.
 *
 * A project may have its own base image (saved from a Setup & Test
 * conversation); otherwise the global/default image is used.
 *
 * @param {string|null|undefined} projectImage
 * @returns {string}
 */
function resolveSandboxImage(projectImage) {
  const value = String(projectImage || '').trim();
  return value || getSandboxConfig().image;
}

/**
 * Persistent cache directory of a project (host side).
 *
 * Every conversation sandbox of the project mounts the same directory at
 * `${containerHome}/.cache`, so downloads survive container recreation.
 * Conversations without a project use a shared `_default` cache.
 *
 * @param {number|string|null|undefined} projectId
 * @returns {string} The absolute path of the directory.
 */
function getProjectSandboxCacheDir(projectId) {
  const config = getSandboxConfig();
  const key = projectId != null && String(projectId).trim() !== ''
    ? `proj-${sanitizeIoKey(projectId)}`
    : DEFAULT_CACHE_KEY;
  const dir = path.join(config.cacheDir, key);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

let newuidmapChecked = false;
let newuidmapAvailable = false;

/**
 * Whether `newuidmap` is available. Without it, rootless podman can only map a
 * single UID — enough for the sandbox (the container root maps to the host user),
 * but the image files owned by other UIDs become "nobody".
 *
 * The detection is based on the *existence* of the binary: `newuidmap --version`
 * prints the usage and exits with 1, so the exit code says nothing.
 *
 * @returns {boolean}
 */
function hasNewuidmap() {
  if (newuidmapChecked) return newuidmapAvailable;
  newuidmapChecked = true;
  try {
    const result = spawnSync('newuidmap', ['--version'], { stdio: 'ignore' });
    // spawnSync reports a missing binary through `error`, not through an exit code.
    newuidmapAvailable = !result.error;
  } catch (_) {
    newuidmapAvailable = false;
  }
  return newuidmapAvailable;
}

/**
 * Resolves the podman binary.
 * Order: `PODMAN_BIN` → `podman` in PATH → the rootless static install.
 * @returns {string}
 */
function resolvePodmanBinary() {
  const config = getSandboxConfig();
  if (config.podmanBin) return config.podmanBin;

  // The rootless static install ships a wrapper in ~/.local/bin that sets the
  // right environment — it is preferred when present.
  const wrapper = path.join(os.homedir(), '.local', 'bin', 'podman');
  if (fs.existsSync(wrapper)) return wrapper;

  try {
    const which = execFileSync('sh', ['-c', 'command -v podman'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const found = String(which || '').trim();
    if (found) return found;
  } catch (_) {}

  const staticInstall = path.join(os.homedir(), '.local', 'podman-static', 'usr', 'local', 'bin', 'podman');
  if (fs.existsSync(staticInstall)) return staticInstall;

  return 'podman';
}

/**
 * Builds the environment for the podman child processes.
 * The container never inherits the host environment (decision D7): the env
 * allowlist is passed explicitly on every `podman exec`.
 *
 * @returns {Object}
 */
function buildPodmanEnv() {
  const env = { ...process.env };
  const config = getSandboxConfig();

  if (config.containersConf) {
    env.CONTAINERS_CONF = config.containersConf;
  }

  if (!env.XDG_RUNTIME_DIR) {
    const runtimeDir = path.join(os.tmpdir(), `podman-run-${os.userInfo().uid}`);
    try {
      fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    } catch (_) {}
    env.XDG_RUNTIME_DIR = runtimeDir;
  }

  if (!hasNewuidmap()) {
    // Force the single-UID mapping: podman looks the subuid range up for $USER,
    // and without `newuidmap` it cannot use a range at all.
    env.USER = config.rootlessUser;
  }

  return env;
}

module.exports = {
  DEFAULT_IMAGE,
  DEFAULT_IDLE_TTL_MIN,
  DEFAULT_CONTAINER_HOME,
  DEFAULT_CONTAINER_PATH,
  GLOBAL_SETUP_MARKER_PATH,
  DEFAULT_IO_MOUNT_TARGET,
  DEFAULT_SHM_SIZE,
  DEFAULT_ULIMIT_STACK,
  getSandboxRuntime,
  getSandboxConfig,
  setSandboxImage,
  hasNewuidmap,
  resolvePodmanBinary,
  buildPodmanEnv,
  sanitizeIoKey,
  getSandboxIoKey,
  getSandboxIoDir,
  getSandboxStackLimit,
  getProjectSandboxCacheDir,
  resolveSandboxImage,
};
