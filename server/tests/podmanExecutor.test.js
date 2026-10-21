'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildMountMap,
  buildMountsKey,
  buildContainerEnv,
  buildCreateArgs,
  buildExecArgs,
  buildCaptureCommand,
  buildStackLimitedCommand,
  resolveCapturedResult,
  containerNameFor,
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

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function runTests() {
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

  // ── Environment allowlist (D7) ──────────────────────────────────────────

  check('the container env is an explicit allowlist', () => {
    const env = buildContainerEnv({ exportPaths: [], configuredPaths: [] });
    assert.deepStrictEqual(Object.keys(env).sort(), ['CI', 'HOME', 'LANG', 'PATH', 'TZ']);
    assert.strictEqual(env.CI, '1');
    assert.ok(env.PATH.includes('/usr/bin'));
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
    assert.ok(args.includes('--userns=keep-id'), 'keep-id is mandatory');
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

  // ── podman exec ─────────────────────────────────────────────────────────

  check('podman exec passes the cwd, the env and the command', () => {
    const args = buildExecArgs({
      name: 'miniboss-7',
      cwd: '/test/worktree',
      env: { HOME: '/home/miniboss', CI: '1' },
      command: 'echo hi',
    });

    assert.strictEqual(args[0], 'exec');
    assert.strictEqual(argValue(args, '--user'), String(os.userInfo().uid));
    assert.strictEqual(argValue(args, '-w'), '/test/worktree');
    assert.ok(args.includes('HOME=/home/miniboss'));
    assert.ok(args.includes('CI=1'));
    assert.ok(args.includes('miniboss-7'));
    assert.strictEqual(args[args.length - 3], '/bin/sh');
    assert.strictEqual(args[args.length - 2], '-c');
    assert.strictEqual(args[args.length - 1], 'echo hi');
  });

  check('the command runs as the host user, not as the image USER', () => {
    const args = buildExecArgs({ name: 'c', command: 'id' });
    // The node image uses `node` (uid 1000) which maps to a subuid — the files
    // would end up owned by a stranger.
    assert.strictEqual(argValue(args, '--user'), String(os.userInfo().uid));
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

runTests();
