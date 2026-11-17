'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildMountMap,
  buildMountsKey,
  buildContainerEnv,
  buildPathKey,
  buildCreateArgs,
  buildExecArgs,
  buildCaptureCommand,
  buildStackLimitedCommand,
  detectSetupInterpreter,
  shouldRetrySetup,
  resolveCapturedResult,
  waitForCapture,
  getCaptureStats,
  containerNameFor,
  containerRecreateReasons,
  captureContainerPath,
  isImageMissingError,
  isContainerMissingError,
} = require('../services/sandbox/podmanExecutor');

let passed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (err) {
    console.error(`❌ ${label}`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
    throw err;
  }
}

async function checkAsync(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (err) {
    console.error(`❌ ${label}`);
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
    throw err;
  }
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

async function runTests() {
  console.log('Running podmanExecutor tests...\n');
  const repoRoot = '/test/repo';
  const worktreePath = '/test/worktree';

  // ── Mount map ───────────────────────────────────────────────────────────

  check('the worktree is mounted read-write by default', () => {
    const mounts = buildMountMap({ repoRoot, worktreePath });
    const worktree = mounts.find(m => m.source === worktreePath);
    assert.ok(worktree, 'the worktree must be mounted');
    assert.strictEqual(worktree.readOnly, false);
    assert.strictEqual(worktree.target, worktreePath, 'the mount keeps the same absolute path');
  });

  check('the repository root is mounted read-only', () => {
    const mounts = buildMountMap({ repoRoot, worktreePath });
    const repo = mounts.find(m => m.source === repoRoot);
    assert.ok(repo, 'the repository root must be mounted');
    assert.strictEqual(repo.readOnly, true);
  });

  check('plan mode mounts the worktree read-only', () => {
    const mounts = buildMountMap({ repoRoot, worktreePath, readOnlyWorktree: true });
    const worktree = mounts.find(m => m.source === worktreePath);
    assert.strictEqual(worktree.readOnly, true);
  });

  check('the project conversation (worktree === repo) is mounted once, read-only', () => {
    const mounts = buildMountMap({ repoRoot, worktreePath: repoRoot });
    assert.strictEqual(mounts.length, 1);
    assert.strictEqual(mounts[0].readOnly, true);
  });

  check('extra paths follow their access mode', () => {
    const extra = path.join(os.tmpdir(), 'miniboss-sandbox-extra');
    fs.mkdirSync(extra, { recursive: true });
    try {
      const mounts = buildMountMap({
        repoRoot,
        worktreePath,
        extraPaths: [
          { path: extra, writable: false },
          { path: path.join(extra, 'missing'), writable: true },
        ],
      });
      const readMount = mounts.find(m => m.source === extra);
      assert.ok(readMount, 'the existing extra path must be mounted');
      assert.strictEqual(readMount.readOnly, true);
      assert.ok(
        !mounts.some(m => m.source === path.join(extra, 'missing')),
        'a non-existent extra path must be skipped'
      );
    } finally {
      fs.rmSync(extra, { recursive: true, force: true });
    }
  });

  check('the mount key changes when the access mode changes', () => {
    const rw = buildMountsKey(buildMountMap({ repoRoot, worktreePath }));
    const ro = buildMountsKey(buildMountMap({ repoRoot, worktreePath, readOnlyWorktree: true }));
    assert.notStrictEqual(rw, ro, 'the container must be recreated when the worktree becomes read-only');
  });

  check('the mount key changes when the container spec changes', () => {
    const key = buildMountsKey(buildMountMap({ repoRoot, worktreePath }));
    assert.ok(key.length > 0);
    assert.ok(/^[0-9a-f]+$/.test(key), 'the key must be safe to store in a podman label');
  });

  // ── Output exchange mount ───────────────────────────────────────────────

  check('the output exchange is mounted read-write at an explicit target', () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-io-'));
    try {
      const mounts = buildMountMap({
        repoRoot,
        worktreePath,
        ioDir,
        ioTarget: '/var/lib/miniboss/io',
      });
      const io = mounts.find(m => m.source === ioDir);
      assert.ok(io, 'the exchange directory must be mounted');
      assert.strictEqual(io.readOnly, false, 'the exchange directory is scratch space');
      assert.strictEqual(io.target, '/var/lib/miniboss/io', 'the mount target is explicit');
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  check('a missing output exchange directory is skipped', () => {
    const missing = path.join(os.tmpdir(), `miniboss-sandbox-io-missing-${process.pid}`);
    const mounts = buildMountMap({
      repoRoot,
      worktreePath,
      ioDir: missing,
      ioTarget: '/var/lib/miniboss/io',
    });
    assert.ok(!mounts.some(m => m.source === missing), 'a non-existent exchange directory must be skipped');
  });

  check('the mount key distinguishes the same source with different targets', () => {
    const a = buildMountsKey([
      { source: '/test/share', target: '/test/share', readOnly: true },
    ]);
    const b = buildMountsKey([
      { source: '/test/share', target: '/var/lib/miniboss/io', readOnly: true },
    ]);
    assert.notStrictEqual(a, b, 'the target is part of the container identity');
  });

  // ── Persistent cache ────────────────────────────────────────────────────

  check('the persistent cache is mounted read-write at the container cache', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-cache-'));
    try {
      const mounts = buildMountMap({ repoRoot, worktreePath, cacheDir });
      const cache = mounts.find(m => m.source === cacheDir);
      assert.ok(cache, 'the cache directory must be mounted');
      assert.strictEqual(cache.readOnly, false);
      assert.strictEqual(cache.target, '/home/miniboss/.cache');
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // ── Setup interpreter ───────────────────────────────────────────────────

  check('the setup interpreter follows the shebang', () => {
    assert.strictEqual(detectSetupInterpreter('#!/usr/bin/env bash\n'), 'bash');
    assert.strictEqual(detectSetupInterpreter('#!/bin/sh\n'), 'sh');
  });

  check('a failed setup is retried only after the backoff or when forced', () => {
    const now = 1000000;
    const retryMs = 5 * 60 * 1000;
    assert.strictEqual(shouldRetrySetup(null, now, retryMs), true, 'a new container retries');
    assert.strictEqual(
      shouldRetrySetup({ setupFailedAt: now - 1000 }, now, retryMs),
      false,
      'a recent failure is not retried'
    );
    assert.strictEqual(
      shouldRetrySetup({ setupFailedAt: now - retryMs }, now, retryMs),
      true,
      'the backoff expires'
    );
    assert.strictEqual(
      shouldRetrySetup({ setupFailedAt: now - 1000 }, now, retryMs, true),
      true,
      'a forced setup always retries'
    );
  });

  // ── Environment allowlist (D7) ──────────────────────────────────────────

  check('the container env is an explicit allowlist', () => {
    const env = buildContainerEnv({ exportPaths: [], configuredPaths: [] });
    assert.deepStrictEqual(
      Object.keys(env).sort(),
      ['CI', 'HOME', 'LANG', 'NPM_CONFIG_CACHE', 'PATH', 'TZ', 'XDG_CACHE_HOME']
    );
    assert.strictEqual(env.CI, '1');
    assert.ok(env.PATH.includes('/usr/bin'));
    assert.strictEqual(env.XDG_CACHE_HOME, '/home/miniboss/.cache');
    assert.strictEqual(env.NPM_CONFIG_CACHE, '/home/miniboss/.cache/npm');
  });

  check('the worktree local bins are added to PATH', () => {
    const env = buildContainerEnv({ worktreePath: '/test/worktree' });
    const parts = env.PATH.split(':');
    assert.ok(parts.includes('/test/worktree/.miniboss/bin'), 'the local bins must be reachable');
    assert.ok(parts.includes('/test/worktree/node_modules/.bin'), 'the node_modules bins must be reachable');
  });

  check('a configured path that is not exported is removed from PATH', () => {
    const configured = '/home/user/.deno/bin';
    const env = buildContainerEnv({ exportPaths: [], configuredPaths: [configured] });
    assert.ok(!env.PATH.split(':').includes(configured));
  });

  check('an exported path is added to PATH', () => {
    const exported = '/home/user/.nvm/bin';
    const env = buildContainerEnv({ exportPaths: [exported], configuredPaths: [exported] });
    assert.ok(env.PATH.split(':').includes(exported));
  });

  // ── Project PATH captured from the saved base image ─────────────────────

  check('the captured PATH is used as the base PATH', () => {
    const env = buildContainerEnv({ basePath: '/opt/deno/bin:/usr/local/bin:/usr/bin' });
    const parts = env.PATH.split(':');
    assert.deepStrictEqual(parts.slice(0, 3), ['/opt/deno/bin', '/usr/local/bin', '/usr/bin']);
    assert.ok(!parts.includes('/sbin'), 'the default PATH is not merged in');
  });

  check('the captured PATH keeps the configured filter and appends export and local bins', () => {
    const configured = '/home/user/.deno/bin';
    const exported = '/home/user/.nvm/bin';
    const env = buildContainerEnv({
      basePath: `${configured}:/usr/bin`,
      exportPaths: [exported],
      configuredPaths: [configured, exported],
      worktreePath: '/test/worktree',
    });
    const parts = env.PATH.split(':');
    assert.ok(!parts.includes(configured), 'a configured path that is not exported is removed');
    assert.ok(parts.includes(exported), 'the exported path is appended');
    assert.ok(parts.includes('/test/worktree/.miniboss/bin'), 'the local bins are appended');
    assert.strictEqual(parts[parts.length - 1], '/test/worktree/node_modules/.bin');
  });

  check('a missing base PATH falls back to the default container PATH', () => {
    const env = buildContainerEnv({ basePath: null });
    assert.ok(env.PATH.split(':').includes('/usr/bin'));
  });

  check('the PATH key is stable and changes with the PATH', () => {
    const a = buildPathKey('/usr/bin:/bin');
    assert.strictEqual(a, buildPathKey('/usr/bin:/bin'));
    assert.notStrictEqual(a, buildPathKey('/opt/deno/bin:/usr/bin:/bin'));
    assert.ok(/^[0-9a-f]{16}$/.test(a), 'the key must be safe to store in a podman label');
  });

  check('a changed PATH is a container recreate reason', () => {
    const info = { mountsKey: 'm', image: 'i', spec: '4', pathKey: 'old' };
    const reasons = containerRecreateReasons(info, { mountsKey: 'm', image: 'i', spec: '4', pathKey: 'new' });
    assert.deepStrictEqual(reasons, ['PATH changed']);
    assert.deepStrictEqual(
      containerRecreateReasons(info, { mountsKey: 'm', image: 'i', spec: '4', pathKey: 'old' }),
      []
    );
  });

  check('captureContainerPath returns the login-shell PATH and ignores profile noise', () => {
    let seenArgs = null;
    const path_ = captureContainerPath('miniboss-1', (args) => {
      seenArgs = args;
      return { stdout: 'welcome to the profile\n/opt/deno/bin:/usr/local/bin:/usr/bin\n', stderr: '', exitCode: 0 };
    });
    assert.strictEqual(path_, '/opt/deno/bin:/usr/local/bin:/usr/bin');
    assert.ok(seenArgs.includes('--user') && seenArgs.includes('root'), 'the login shell runs as root');
    assert.ok(seenArgs.includes('bash -lc') || seenArgs.some(a => String(a).includes('bash -lc')), 'bash login shell is preferred');
  });

  check('captureContainerPath returns null on failure or empty output', () => {
    assert.strictEqual(captureContainerPath('c', () => ({ stdout: '/usr/bin', stderr: 'boom', exitCode: 1 })), null);
    assert.strictEqual(captureContainerPath('c', () => ({ stdout: '', stderr: '', exitCode: 0 })), null);
    assert.strictEqual(captureContainerPath('c', () => ({ stdout: 'not-a-path', stderr: '', exitCode: 0 })), null);
  });

  // ── podman create ───────────────────────────────────────────────────────

  check('podman create isolates the container and labels it', () => {
    const args = buildCreateArgs({
      name: 'miniboss-42',
      image: 'docker.io/library/node:22-bookworm',
      mounts: buildMountMap({ repoRoot, worktreePath }),
      env: buildContainerEnv({}),
      labels: {
        miniboss: 'true',
        'miniboss.conversation': '42',
        'miniboss.worktree': worktreePath,
      },
      workdir: worktreePath,
    });

    assert.strictEqual(args[0], 'create');
    assert.strictEqual(argValue(args, '--name'), 'miniboss-42');
    assert.ok(args.includes('--userns=keep-id:uid=0,gid=0'), 'keep-id must map the container root to the host user');
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.ok(args.includes('--security-opt=no-new-privileges'));
    assert.ok(args.includes('miniboss=true'), 'the miniboss label must be set');
    assert.ok(args.includes('miniboss.conversation=42'));
    assert.ok(args.includes('miniboss.worktree=/test/worktree'));
    assert.ok(args.includes(`${worktreePath}:${worktreePath}:rw`));
    assert.ok(args.includes(`${repoRoot}:${repoRoot}:ro`));
    assert.strictEqual(argValue(args, '-w'), worktreePath);
    assert.ok(args.includes('docker.io/library/node:22-bookworm'));
    assert.ok(
      args[args.length - 2] === '-c' && /kill -TERM 0/.test(args[args.length - 1]),
      'the container init must forward the stop signal (PID 1 ignores unhandled signals)'
    );
  });

  check('podman create mounts a read-only worktree as :ro', () => {
    const args = buildCreateArgs({
      name: 'miniboss-1',
      image: 'image',
      mounts: buildMountMap({ repoRoot, worktreePath, readOnlyWorktree: true }),
      env: {},
      labels: {},
    });
    assert.ok(args.includes(`${worktreePath}:${worktreePath}:ro`));
  });

  check('podman create can disable the network', () => {
    const args = buildCreateArgs({
      name: 'miniboss-1',
      image: 'image',
      mounts: [],
      env: {},
      labels: {},
      network: 'none',
    });
    assert.strictEqual(argValue(args, '--network'), 'none');
  });

  // ── Container resources ─────────────────────────────────────────────────

  check('podman create raises /dev/shm', () => {
    const args = buildCreateArgs({
      name: 'miniboss-1',
      image: 'image',
      mounts: [],
      env: {},
      labels: {},
      shmSize: '1g',
    });
    assert.strictEqual(argValue(args, '--shm-size'), '1g');
  });

  check('podman create only sets the stack limit when it is asked for', () => {
    // `podman create --ulimit stack=` makes the apt method crash with SIGSEGV
    // in rootless containers, so it is opt-in.
    const without = buildCreateArgs({ name: 'miniboss-1', image: 'image', mounts: [], env: {}, labels: {} });
    assert.strictEqual(argValue(without, '--ulimit'), null);

    const with_ = buildCreateArgs({
      name: 'miniboss-1',
      image: 'image',
      mounts: [],
      env: {},
      labels: {},
      ulimitStack: '65536:65536',
    });
    assert.strictEqual(argValue(with_, '--ulimit'), 'stack=65536:65536');
  });

  check('podman create can leave /dev/shm untouched', () => {
    const args = buildCreateArgs({
      name: 'miniboss-1',
      image: 'image',
      mounts: [],
      env: {},
      labels: {},
      shmSize: '',
    });
    assert.strictEqual(argValue(args, '--shm-size'), null);
  });

  check('the stack limit is raised inside the command', () => {
    const limited = buildStackLimitedCommand('echo hi', '65536');
    assert.ok(limited.startsWith('ulimit -s 65536'), 'the ulimit builtin raises the soft limit');
    assert.ok(limited.endsWith('echo hi'), 'the command is preserved');
    assert.strictEqual(buildStackLimitedCommand('echo hi', null), 'echo hi');
  });

  // ── Output capture ──────────────────────────────────────────────────────

  check('the capture command redirects the output and records the exit code', () => {
    const command = buildCaptureCommand('echo hello', { ioTarget: '/var/lib/miniboss/io', id: 'run-1' });

    assert.ok(command.includes('if [ -f'), 'the capture needs the mount sentinel');
    assert.ok(command.includes('/var/lib/miniboss/io/run-1.out'), 'stdout is captured in a file');
    assert.ok(command.includes('/var/lib/miniboss/io/run-1.err'), 'stderr is captured in a file');
    assert.ok(command.includes('/var/lib/miniboss/io/run-1.rc'), 'the exit code is captured in a file');
    assert.ok(command.includes('printf %s "$?"'), 'the exit code is the status of the command');
    assert.ok(command.includes('else'), 'there must be a fallback branch');
    assert.ok(command.includes("sh -c 'echo hello'"), 'the command runs exactly once per branch');
  });

  check('the capture command keeps the timeout wrapper inside the redirected block', () => {
    const command = buildCaptureCommand(
      "timeout -k 5 30 /bin/sh -c 'sleep 60'",
      { ioTarget: '/var/lib/miniboss/io', id: 'run-2' }
    );
    const lines = command.split('\n');
    const redirectIndex = lines.findIndex(line => line.includes('run-2.out'));
    const timeoutIndex = lines.findIndex(line => line.includes('timeout -k 5 30'));
    assert.ok(redirectIndex !== -1 && timeoutIndex !== -1, 'the command must be redirected');
    assert.strictEqual(redirectIndex, timeoutIndex, 'the timeout wrapper is inside the redirected block');
  });

  check('the capture result prefers the files over the exec stream', () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-capture-'));
    try {
      const id = 'run-3';
      fs.writeFileSync(path.join(ioDir, `${id}.out`), 'file stdout\n');
      fs.writeFileSync(path.join(ioDir, `${id}.err`), 'file stderr\n');
      fs.writeFileSync(path.join(ioDir, `${id}.rc`), '7\n');

      const result = resolveCapturedResult({
        mode: 'file',
        ioDir,
        id,
        stream: { stdout: '', stderr: '', exitCode: 0 },
      });

      assert.strictEqual(result.stdout, 'file stdout');
      assert.strictEqual(result.stderr, 'file stderr');
      assert.strictEqual(result.exitCode, 7);
      assert.strictEqual(result.failed, true);
      assert.strictEqual(result.captureSource, 'file');
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  check('the capture result falls back to the exec stream without the exit code file', () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-capture-'));
    try {
      const result = resolveCapturedResult({
        mode: 'file',
        ioDir,
        id: 'run-4',
        stream: { stdout: 'stream stdout', stderr: '', exitCode: 0 },
      });

      assert.strictEqual(result.stdout, 'stream stdout');
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.captureSource, 'fallback');
      assert.ok(result.stderr.includes('fell back to the exec stream'), 'the fallback is reported');
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  check('the capture result reports a timeout recorded in the exit code file', () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-capture-'));
    try {
      const id = 'run-5';
      fs.writeFileSync(path.join(ioDir, `${id}.out`), '');
      fs.writeFileSync(path.join(ioDir, `${id}.err`), '');
      fs.writeFileSync(path.join(ioDir, `${id}.rc`), '124');

      const result = resolveCapturedResult({
        mode: 'file',
        ioDir,
        id,
        stream: { stdout: '', stderr: '', exitCode: 0 },
      });

      assert.strictEqual(result.exitCode, 124);
      assert.strictEqual(result.timedOut, true);
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  check('the stream mode ignores the capture files', () => {
    const result = resolveCapturedResult({
      mode: 'stream',
      ioDir: null,
      id: null,
      stream: { stdout: 'raw stream', stderr: 'raw stderr', exitCode: 0 },
    });

    assert.strictEqual(result.stdout, 'raw stream');
    assert.strictEqual(result.captureSource, 'stream');
    assert.ok(!result.stderr.includes('fell back'), 'the stream mode is not a fallback');
  });

  check('never returns silent empty on exit-0 when the capture files never appear', () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-capture-'));
    try {
      const result = resolveCapturedResult({
        mode: 'file',
        ioDir,
        id: 'run-empty',
        stream: { stdout: '', stderr: '', exitCode: 0 },
      });

      assert.strictEqual(result.captureSource, 'fallback');
      assert.ok(result.stderr.includes('capture lost'), 'the loss must be surfaced, not silent');
      assert.strictEqual(result.stdout, '', 'there is genuinely nothing to return');
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  check('prefers the stream stderr over an empty stdout on fallback', () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-capture-'));
    try {
      const result = resolveCapturedResult({
        mode: 'file',
        ioDir,
        id: 'run-stderr',
        stream: { stdout: '', stderr: 'error from the stream', exitCode: 0 },
      });

      assert.strictEqual(result.captureSource, 'fallback');
      assert.strictEqual(result.stdout, 'error from the stream', 'the stream content must not be dropped');
      assert.ok(result.stderr.includes('fell back'), 'the fallback is still reported');
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  check('does not flag a killed command as capture lost', () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-capture-'));
    try {
      const result = resolveCapturedResult({
        mode: 'file',
        ioDir,
        id: 'run-killed',
        stream: { stdout: '', stderr: '', exitCode: 124 },
        timedOut: true,
      });

      assert.strictEqual(result.captureSource, 'fallback');
      assert.ok(!result.stderr.includes('capture lost'), 'a killed command has no output to lose');
      assert.ok(result.stderr.includes('fell back'), 'the timeout fallback is reported');
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  await checkAsync('waitForCapture returns true once the exit-code file appears during the wait', async () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-wait-'));
    try {
      const id = 'run-late';
      setTimeout(() => fs.writeFileSync(path.join(ioDir, `${id}.rc`), '0\n'), 60);
      const appeared = await waitForCapture(ioDir, id, 500, 20);
      assert.strictEqual(appeared, true, 'the late-written exit code must be seen');
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  await checkAsync('waitForCapture returns false when the exit-code file never appears', async () => {
    const ioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniboss-sandbox-wait-'));
    try {
      const before = getCaptureStats().waitMiss;
      const appeared = await waitForCapture(ioDir, 'run-never', 120, 20);
      assert.strictEqual(appeared, false, 'the wait must time out');
      assert.strictEqual(getCaptureStats().waitMiss, before + 1, 'a timed-out wait is counted');
    } finally {
      fs.rmSync(ioDir, { recursive: true, force: true });
    }
  });

  // ── podman exec ─────────────────────────────────────────────────────────

  check('podman exec passes the cwd, the env and the command', () => {
    const args = buildExecArgs({
      name: 'miniboss-7',
      cwd: '/test/worktree',
      env: { HOME: '/home/miniboss', CI: '1' },
      command: 'echo hi',
    });

    assert.strictEqual(args[0], 'exec');
    assert.strictEqual(argValue(args, '--user'), 'root');
    assert.strictEqual(argValue(args, '-w'), '/test/worktree');
    assert.ok(args.includes('HOME=/home/miniboss'));
    assert.ok(args.includes('CI=1'));
    assert.ok(args.includes('miniboss-7'));
    assert.strictEqual(args[args.length - 3], '/bin/sh');
    assert.strictEqual(args[args.length - 2], '-c');
    assert.strictEqual(args[args.length - 1], 'echo hi');
  });

  check('the command runs as container root, not as the image USER', () => {
    const args = buildExecArgs({ name: 'c', command: 'id' });
    // `--userns=keep-id` maps this root to the host user, so installed packages
    // are possible while written files stay host-owned.
    assert.strictEqual(argValue(args, '--user'), 'root');
  });

  check('the container keeps a usable capability set', () => {
    const args = buildCreateArgs({ name: 'c', image: 'i', mounts: [], env: {}, labels: {} });
    assert.ok(args.includes('--cap-drop=ALL'));
    // DAC_OVERRIDE is needed by the container root to write to the worktree.
    assert.ok(String(argValue(args, '--cap-add') || '').includes('DAC_OVERRIDE'));
    // The dangerous ones must stay out.
    const caps = String(argValue(args, '--cap-add') || '');
    assert.ok(!caps.includes('NET_ADMIN'));
    assert.ok(!caps.includes('SYS_ADMIN'));
  });

  // ── Naming and error classification ─────────────────────────────────────

  check('the container name is derived from the conversation id', () => {
    assert.strictEqual(containerNameFor(42), 'miniboss-42');
  });

  check('the podman errors are classified', () => {
    assert.strictEqual(isImageMissingError('Error: image not known'), true);
    assert.strictEqual(isImageMissingError('Error: no such image'), true);
    assert.strictEqual(isImageMissingError('some other error'), false);
    assert.strictEqual(isContainerMissingError('Error: no such container miniboss-1'), true);
    assert.strictEqual(isContainerMissingError('Error: creating container storage'), false);
  });

  console.log(`\nAll podmanExecutor tests passed (${passed} checks).`);
}

runTests()
  .catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
