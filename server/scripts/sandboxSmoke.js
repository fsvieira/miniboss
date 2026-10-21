#!/usr/bin/env node
'use strict';

/**
 * Live sandbox smoke test (Podman).
 *
 * Creates a throw-away repository + worktree with a `.miniboss/setup.sh`, runs a
 * few commands through the sandbox and asserts the guarantees the sandbox is
 * supposed to provide.
 *
 * Usage:
 *   node server/scripts/sandboxSmoke.js
 *
 * Requires a working rootless podman (see `checkSandboxRuntime`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runPodmanCommand, stopIdleContainers, removeContainerForConversation } = require('../services/sandbox/podmanExecutor');
const { getSandboxConfig, resolvePodmanBinary, buildPodmanEnv } = require('../services/sandbox/runtime');

/** Root of the MiniBoss repository (the repository setup script under test). */
const MINIBOSS_ROOT = path.resolve(__dirname, '..', '..');

const CONVERSATION_ID = `smoke-${process.pid}`;
const ROOT = path.join(os.tmpdir(), `miniboss-sandbox-smoke-${process.pid}`);

let passed = 0;
let failed = 0;

function ok(label) {
  passed += 1;
  console.log(`✅ ${label}`);
}

function fail(label, detail) {
  failed += 1;
  console.error(`❌ ${label}`);
  if (detail) console.error(`   ${detail}`);
}

function assert(label, condition, detail) {
  if (condition) ok(label);
  else fail(label, detail);
}

function run(container, args, options = {}) {
  return execFileSync(resolvePodmanBinary(), args, {
    env: buildPodmanEnv(),
    encoding: 'utf8',
    timeout: options.timeoutMs || 60000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function main() {
  const config = getSandboxConfig();
  console.log('── Sandbox smoke test ──');
  console.log(`Runtime: podman — image ${config.image}\n`);

  const repoRoot = path.join(ROOT, 'repo');
  const worktreePath = path.join(ROOT, 'worktree');

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });

  execFileSync('git', ['init', '-q'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'smoke@test.com'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Smoke'], { cwd: repoRoot, stdio: 'ignore' });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# smoke\n');
  execFileSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repoRoot, stdio: 'ignore' });

  // The repository setup script is the REAL one of this repository: the test
  // proves the split between the global script (generic toolbox) and the
  // repository script (project-specific tools).
  //
  // Two probes are injected around it:
  //   - `setup-runs.log`  → the script marks itself as executed (runs once);
  //   - `tool-before`     → what the generic toolbox had installed *before*
  //                         the repository script ran (must NOT contain the
  //                         project-specific tools).
  const setupDir = path.join(worktreePath, '.miniboss');
  fs.mkdirSync(setupDir, { recursive: true });
  const repositorySetup = path.join(MINIBOSS_ROOT, '.miniboss', 'setup.sh');
  const setupBody = fs.existsSync(repositorySetup)
    ? fs.readFileSync(repositorySetup, 'utf8')
    : [
        '#!/bin/sh',
        'set -e',
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update -qq',
        'apt-get install -y -qq --no-install-recommends sqlite3',
        'rm -rf /var/lib/apt/lists/*',
        '',
      ].join('\n');
  const setupScript = setupBody.replace(
    /^#!.*\n/,
    [
      '#!/bin/sh',
      'echo "setup ran at $(date +%s)" >> /home/miniboss/setup-runs.log',
      'echo "setup-ok" > /home/miniboss/setup-marker',
      'echo "before=$(command -v sqlite3 || echo missing)" > /home/miniboss/tool-before',
      'echo "SETUP COMPLETED"',
      '',
    ].join('\n')
  );
  fs.writeFileSync(path.join(setupDir, 'setup.sh'), setupScript, { mode: 0o755 });

  const baseOpts = {
    repoRoot,
    worktreePath,
    conversationId: CONVERSATION_ID,
    extraPaths: [],
    exportPaths: [],
    configuredPaths: [],
  };

  try {
    // ── 1. A command runs in the sandbox ───────────────────────────────────
    const hello = await runPodmanCommand('echo hello-from-sandbox', worktreePath, 30000, baseOpts);
    assert('the command runs inside the container', hello.stdout.includes('hello-from-sandbox'), hello.stderr);
    assert('the command exits with 0', hello.exitCode === 0, `exit=${hello.exitCode} ${hello.stderr}`);

    // ── 2. The setup script ran ───────────────────────────────────────────
    const setupLog = await runPodmanCommand('cat /home/miniboss/setup-marker 2>/dev/null || echo missing', worktreePath, 30000, baseOpts);
    assert('the setup script ran inside the container', setupLog.stdout.includes('setup-ok'), setupLog.stdout);

    // ── 3. The worktree is writable from the host after a container write ──
    await runPodmanCommand('echo written-by-container > written.txt', worktreePath, 30000, baseOpts);
    const written = path.join(worktreePath, 'written.txt');
    assert('the container write is visible on the host', fs.existsSync(written));
    if (fs.existsSync(written)) {
      const stat = fs.statSync(written);
      assert(
        'the file is owned by the host user (keep-id)',
        stat.uid === os.userInfo().uid,
        `uid=${stat.uid} expected=${os.userInfo().uid}`
      );
    }

    // ── 4. Plan mode: the worktree is read-only ───────────────────────────
    const planOpts = { ...baseOpts, readOnlyWorktree: true };
    const readOnly = await runPodmanCommand('echo should-fail > blocked.txt', worktreePath, 30000, planOpts);
    assert('a write in plan mode fails', readOnly.exitCode !== 0, `exit=${readOnly.exitCode}`);
    assert(
      'the failure mentions a read-only filesystem',
      /read-only|readonly|EROFS/i.test(`${readOnly.stderr} ${readOnly.stdout}`),
      readOnly.stderr
    );
    assert('the blocked file was not created', !fs.existsSync(path.join(worktreePath, 'blocked.txt')));

    // The container was recreated for the read-only mount map.
    const writeAgain = await runPodmanCommand('echo ok > allowed.txt', worktreePath, 30000, baseOpts);
    assert('the sandbox works again after the read-only container', writeAgain.exitCode === 0, writeAgain.stderr);

    // ── 5. The host environment does not leak ──────────────────────────────
    const env = await runPodmanCommand('env', worktreePath, 30000, baseOpts);
    assert('PORT is not visible inside the container', !/^PORT=/m.test(env.stdout), env.stdout);
    assert('PM2_HOME is not visible inside the container', !/^PM2_HOME=/m.test(env.stdout));
    assert('pm_id is not visible inside the container', !/^pm_id=/m.test(env.stdout));
    assert('the env allowlist is applied', /^HOME=/m.test(env.stdout) && /^CI=1$/m.test(env.stdout));

    // ── 6. /tmp is writable ────────────────────────────────────────────────
    const tmp = await runPodmanCommand('touch /tmp/miniboss-smoke && echo tmp-ok', worktreePath, 30000, baseOpts);
    assert('/tmp is writable inside the container', tmp.stdout.includes('tmp-ok'), tmp.stderr);

    // ── 7. The setup script runs only once across a stop/restart ──────────
    const runsBefore = await runPodmanCommand('wc -l < /home/miniboss/setup-runs.log', worktreePath, 30000, baseOpts);
    stopIdleContainers(0);
    const afterStop = await runPodmanCommand('echo after-restart', worktreePath, 30000, baseOpts);
    assert('the container restarts after an idle stop', afterStop.exitCode === 0, afterStop.stderr);
    const runsAfter = await runPodmanCommand('wc -l < /home/miniboss/setup-runs.log', worktreePath, 30000, baseOpts);
    assert(
      'the setup script did not run again after the restart',
      runsBefore.stdout.trim() === runsAfter.stdout.trim(),
      `before=${runsBefore.stdout.trim()} after=${runsAfter.stdout.trim()}`
    );

    // ── 8. The npm cache lives inside the container ────────────────────────
    const npmCache = await runPodmanCommand('npm config get cache', worktreePath, 30000, baseOpts);
    assert(
      'the npm cache is the container-owned one (not the read-only host cache)',
      npmCache.stdout.includes('/home/miniboss'),
      npmCache.stdout
    );

    // ── 9. The output capture returns the whole output ─────────────────────
    const big = await runPodmanCommand(
      "head -c 3000 /dev/zero | tr '\\0' 'a'",
      worktreePath,
      30000,
      baseOpts
    );
    assert(
      'a 3 KB output comes back complete',
      big.stdout.length === 3000,
      `bytes=${big.stdout.length} exit=${big.exitCode} ${big.stderr}`
    );
    assert('the exit code of the big output is 0', big.exitCode === 0, `exit=${big.exitCode}`);

    // ── 10. stdout, stderr and the exit code are captured ─────────────────
    const mixed = await runPodmanCommand('echo to-stdout; echo to-stderr 1>&2; exit 7', worktreePath, 30000, baseOpts);
    assert('stdout is captured', mixed.stdout.includes('to-stdout'), `stdout=${mixed.stdout}`);
    assert('stderr is captured', mixed.stderr.includes('to-stderr'), `stderr=${mixed.stderr}`);
    assert('the exit code is captured', mixed.exitCode === 7, `exit=${mixed.exitCode}`);

    // ── 11. Plan mode: the exchange is rw, the worktree is ro ─────────────
    const planOutput = await runPodmanCommand('echo plan-ok', worktreePath, 30000, planOpts);
    assert(
      'the container still works in plan mode',
      planOutput.stdout.includes('plan-ok'),
      `stdout=${planOutput.stdout} ${planOutput.stderr}`
    );

    let mounts = [];
    try {
      mounts = JSON.parse(String(run(null, [
        'inspect', `miniboss-${CONVERSATION_ID}`, '--format', '{{json .Mounts}}',
      ])).trim());
    } catch (err) {
      fail('the container mounts can be inspected', err && err.message ? err.message : String(err));
    }
    const ioMount = mounts.find(m => String(m.Destination || '').endsWith('/io'));
    assert('the output exchange is mounted read-write', ioMount && ioMount.RW === true, JSON.stringify(ioMount || null));
    const worktreeMount = mounts.find(m => String(m.Destination || '') === worktreePath);
    assert('the worktree is mounted read-only in plan mode', worktreeMount && worktreeMount.RW === false, JSON.stringify(worktreeMount || null));

    // ── 12. The global setup installed the generic toolbox ────────────────
    const generic = await runPodmanCommand(
      'command -v jq; command -v rg; command -v ip',
      worktreePath,
      30000,
      baseOpts
    );
    const genericFound = String(generic.stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
    const genericMissing = ['jq', 'rg', 'ip'].filter(t => !genericFound.some(f => f.endsWith(`/${t}`)));
    assert(
      'the global setup installed the generic tools (jq, rg, ip)',
      genericMissing.length === 0,
      `missing: ${genericMissing.join(', ')}`
    );

    // ── 13. The repository setup installed the project-specific tools ─────
    const projectTool = await runPodmanCommand('command -v sqlite3', worktreePath, 30000, baseOpts);
    assert(
      'the repository setup installed sqlite3',
      /\/sqlite3$/.test(String(projectTool.stdout || '').trim()),
      `stdout=${projectTool.stdout} ${projectTool.stderr}`
    );

    const before = await runPodmanCommand('cat /home/miniboss/tool-before', worktreePath, 30000, baseOpts);
    assert(
      'the global setup did NOT install the project-specific tools',
      before.stdout.trim() === 'before=missing',
      `stdout=${before.stdout.trim()} (the global script must not provide sqlite3)`
    );
  } finally {
    try {
      removeContainerForConversation(CONVERSATION_ID);
    } catch (_) {}
    fs.rmSync(ROOT, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[sandboxSmoke] Failed:', err && err.stack ? err.stack : err);
    process.exit(2);
  });
