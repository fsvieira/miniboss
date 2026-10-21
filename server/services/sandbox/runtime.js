const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

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
const DEFAULT_SETUP_SCRIPT = '.miniboss/setup.sh';
const SETUP_MARKER_PATH = '/var/lib/miniboss/setup.done';
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
  return {
    runtime: getSandboxRuntime(),
    image: imageOverride || (process.env.SANDBOX_IMAGE || DEFAULT_IMAGE).trim(),
    idleTtlMs: (Number.isFinite(idleTtlMin) && idleTtlMin > 0 ? idleTtlMin : DEFAULT_IDLE_TTL_MIN) * 60 * 1000,
    containerHome: (process.env.SANDBOX_CONTAINER_HOME || DEFAULT_CONTAINER_HOME).trim(),
    containerPath: (process.env.SANDBOX_CONTAINER_PATH || DEFAULT_CONTAINER_PATH).trim(),
    setupScript: (process.env.SANDBOX_SETUP_SCRIPT || DEFAULT_SETUP_SCRIPT).trim(),
    setupMarkerPath: SETUP_MARKER_PATH,
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
  DEFAULT_SETUP_SCRIPT,
  SETUP_MARKER_PATH,
  getSandboxRuntime,
  getSandboxConfig,
  setSandboxImage,
  hasNewuidmap,
  resolvePodmanBinary,
  buildPodmanEnv,
};
