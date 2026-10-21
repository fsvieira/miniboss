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
