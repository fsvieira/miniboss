'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  getTrackedFiles,
  invalidateCache,
  isBinary,
  resolveTrackedFile,
  readTextFile,
  searchContent,
  CodeNavigatorError,
  MAX_FILE_BYTES,
} = require('../services/codeNavigator');

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

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Build a real git repo so git ls-files / git grep can be exercised.
function createRepo(files) {
  const root = makeTempDir('code-nav-repo-');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

function runTests() {
  console.log('Running codeNavigator tests...\n');

  check('isBinary detects a NUL byte in the probe range', () => {
    const buf = Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')]);
    assert.strictEqual(isBinary(buf), true);
  });

  check('isBinary treats text without NUL as non-binary', () => {
    assert.strictEqual(isBinary(Buffer.from('hello world', 'utf8')), false);
  });

  check('resolveTrackedFile resolves a valid tracked relpath', () => {
    const repoRoot = '/repo';
    const abs = resolveTrackedFile(repoRoot, 'src/app.js', ['src/app.js']);
    assert.strictEqual(abs, path.resolve(repoRoot, 'src/app.js'));
  });

  check('resolveTrackedFile rejects an absolute path', () => {
    assert.throws(
      () => resolveTrackedFile('/repo', '/etc/passwd', ['/etc/passwd']),
      (err) => err instanceof CodeNavigatorError && err.code === 'not-found'
    );
  });

  check('resolveTrackedFile rejects path traversal', () => {
    assert.throws(
      () => resolveTrackedFile('/repo', '../outside', ['src/a.js']),
      (err) => err instanceof CodeNavigatorError && err.code === 'not-found'
    );
  });

  check('resolveTrackedFile rejects an untracked path', () => {
    assert.throws(
      () => resolveTrackedFile('/repo', 'src/secret.js', ['src/a.js']),
      (err) => err instanceof CodeNavigatorError && err.code === 'not-found'
    );
  });

  checkAsync('getTrackedFiles lists only tracked files and caches per project', async () => {
    const root = createRepo({
      'src/a.js': 'const a = 1;\n',
      'src/nested/b.txt': 'hello\n',
      'README.md': '# hi\n',
    });
    invalidateCache(999);
    const files = await getTrackedFiles(999, root);
    assert.ok(files.includes('src/a.js'));
    assert.ok(files.includes('README.md'));
    // Nothing in the list should be inside .git or end with a slash.
    assert.ok(!files.some((f) => f.startsWith('.git')));
    assert.ok(!files.some((f) => f.endsWith('/')));
  });

  checkAsync('invalidateCache forces a refresh of tracked files', async () => {
    const root = createRepo({ 'only.txt': 'x\n' });
    invalidateCache(888);
    const first = await getTrackedFiles(888, root);
    assert.ok(first.includes('only.txt'));
    fs.writeFileSync(path.join(root, 'added.txt'), 'y\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: root });
    // Still cached (TTL active) — must invalidate explicitly to see the new file.
    const cached = await getTrackedFiles(888, root);
    assert.ok(!cached.includes('added.txt'));
    invalidateCache(888);
    const refreshed = await getTrackedFiles(888, root);
    assert.ok(refreshed.includes('added.txt'));
  });

  check('readTextFile reads and decodes a tracked text file', () => {
    const root = createRepo({ 'a.txt': 'line1\nline2\nline3\n' });
    const tracked = ['a.txt'];
    const { content, lineCount, path: filePath } = readTextFile(root, 'a.txt', tracked);
    assert.strictEqual(content, 'line1\nline2\nline3\n');
    assert.strictEqual(lineCount, 4);
    assert.strictEqual(filePath, 'a.txt');
  });

  check('readTextFile rejects a binary tracked file', () => {
    const root = makeTempDir('code-nav-bin-');
    fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.concat([Buffer.from('xx'), Buffer.from([0])]));
    const tracked = ['bin.dat'];
    assert.throws(
      () => readTextFile(root, 'bin.dat', tracked),
      (err) => err instanceof CodeNavigatorError && err.code === 'binary'
    );
  });

  check('readTextFile rejects a file above the size cap', () => {
    const root = makeTempDir('code-nav-big-');
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x61);
    fs.writeFileSync(path.join(root, 'big.txt'), big);
    const tracked = ['big.txt'];
    assert.throws(
      () => readTextFile(root, 'big.txt', tracked),
      (err) => err instanceof CodeNavigatorError && err.code === 'too-large'
    );
  });

  check('readTextFile rejects an untracked file path', () => {
    const root = makeTempDir('code-nav-untracked-');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'hi\n');
    assert.throws(
      () => readTextFile(root, 'untracked.txt', ['other.txt']),
      (err) => err instanceof CodeNavigatorError && err.code === 'not-found'
    );
  });

  checkAsync('searchContent returns file:line:text hits', async () => {
    const root = createRepo({
      'src/hello.js': 'function greet() {\n  return "Hello World";\n}\n',
      'other.txt': 'nothing here\n',
    });
    const results = await searchContent(root, 'hello');
    assert.ok(results.some((r) => r.file === 'src/hello.js' && r.text.includes('Hello World')));
  });

  checkAsync('searchContent treats no-match (git grep exit 1) as empty', async () => {
    const root = createRepo({ 'a.txt': 'alpha\n' });
    const results = await searchContent(root, 'zzzz-no-match');
    assert.deepStrictEqual(results, []);
  });

  checkAsync('searchContent returns empty for a blank term', async () => {
    const root = createRepo({ 'a.txt': 'alpha\n' });
    assert.deepStrictEqual(await searchContent(root, ''), []);
  });

  console.log(`\nAll codeNavigator tests passed (${passed} checks).`);
}

runTests();
