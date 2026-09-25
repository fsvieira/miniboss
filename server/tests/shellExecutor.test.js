const assert = require('assert');
const path = require('path');
const os = require('os');
const { runShellCommand, buildBwrapArgs } = require('../services/shellExecutor');

async function runTests() {
  console.log('Running shellExecutor tests...\n');

  // Test 1: buildBwrapArgs basic structure
  console.log('Test 1: buildBwrapArgs() basic structure');
  const repoRoot = '/test/repo';
  const worktreePath = '/test/worktree';
  const args = buildBwrapArgs(repoRoot, worktreePath);
  
  assert.ok(Array.isArray(args), 'buildBwrapArgs should return array');
  assert.strictEqual(args[0], 'bwrap', 'First arg should be bwrap');
  assert.ok(args.includes('--ro-bind'), 'Should include --ro-bind');
  assert.ok(args.includes('--bind'), 'Should include --bind');
  assert.ok(args.includes('--dev-bind'), 'Should include --dev-bind');
  assert.ok(args.includes('--proc'), 'Should include --proc');
  assert.ok(args.includes('--share-net'), 'Should include --share-net');
  assert.ok(args.includes('--die-with-parent'), 'Should include --die-with-parent');
  console.log('  Args:', args.join(' ').slice(0, 200) + '...\n');

  // Test 2: buildBwrapArgs includes repoRoot and worktreePath
  console.log('Test 2: buildBwrapArgs includes correct paths');
  assert.ok(args.includes(repoRoot), 'Should include repoRoot');
  assert.ok(args.includes(worktreePath), 'Should include worktreePath');
  console.log('  Paths verified\n');

  // Test 3: buildBwrapArgs does not include home directory binds
  console.log('Test 3: buildBwrapArgs excludes home directory binds');
  const homeDir = os.homedir();
  assert.ok(!args.includes(homeDir), 'Should not include homeDir');
  assert.ok(!args.includes(path.join(homeDir, '.ssh')), 'Should not include ~/.ssh');
  assert.ok(!args.includes(path.join(homeDir, '.gitconfig')), 'Should not include ~/.gitconfig');
  assert.ok(!args.includes(path.join(homeDir, '.npm')), 'Should not include ~/.npm');
  assert.ok(!args.includes(path.join(homeDir, '.cache')), 'Should not include ~/.cache');
  assert.ok(!args.includes(path.join(homeDir, '.config')), 'Should not include ~/.config');
  assert.ok(!args.includes(path.join(homeDir, '.local', 'bin')), 'Should not include ~/.local/bin');
  console.log('  No home directory binds found\n');

  // Test 4: runShellCommand with valid sandbox options
  console.log('Test 4: runShellCommand with valid sandbox options');
  const fs = require('fs');
  const testRepoRoot = '/tmp/test_sandbox_repo';
  const testWorktreePath = '/tmp/test_sandbox_worktree';
  
  if (fs.existsSync(testRepoRoot)) fs.rmSync(testRepoRoot, { recursive: true, force: true });
  if (fs.existsSync(testWorktreePath)) fs.rmSync(testWorktreePath, { recursive: true, force: true });
  
  fs.mkdirSync(testRepoRoot, { recursive: true });
  fs.mkdirSync(testWorktreePath, { recursive: true });
  
  const { execSync } = require('child_process');
  execSync('git init -q', { cwd: testRepoRoot, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: testRepoRoot, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: testRepoRoot, stdio: 'ignore' });
  execSync('echo "test" > test.txt && git add . && git commit -q -m "init"', { cwd: testRepoRoot, stdio: 'ignore' });
  
  try {
    const result = await runShellCommand('echo hello', testWorktreePath, 0, { 
      repoRoot: testRepoRoot, 
      worktreePath: testWorktreePath 
    });
    assert.strictEqual(result.exitCode, 0, 'Should exit with code 0');
    assert.ok(result.stdout.includes('hello'), 'Should output hello');
    console.log('  Sandbox execution works\n');
  } finally {
    fs.rmSync(testRepoRoot, { recursive: true, force: true });
    fs.rmSync(testWorktreePath, { recursive: true, force: true });
  }

  // Test 5: runShellCommand throws when repoRoot missing
  console.log('Test 5: runShellCommand throws when repoRoot missing');
  try {
    await runShellCommand('echo hello', '.', 0, { 
      repoRoot: null, 
      worktreePath: '/test/worktree' 
    });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('repoRoot and worktreePath'), 'Should throw about missing paths');
    console.log('  Throws correctly:', err.message.slice(0, 80), '\n');
  }

  // Test 6: runShellCommand throws when worktreePath missing
  console.log('Test 6: runShellCommand throws when worktreePath missing');
  try {
    await runShellCommand('echo hello', '.', 0, { 
      repoRoot: '/test/repo', 
      worktreePath: null 
    });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('repoRoot and worktreePath'), 'Should throw about missing paths');
    console.log('  Throws correctly:', err.message.slice(0, 80), '\n');
  }

  // Test 7: runShellCommand throws when cwd outside worktree
  console.log('Test 7: runShellCommand throws when cwd outside worktree');
  try {
    await runShellCommand('echo hello', '/tmp', 0, { 
      repoRoot: '/test/repo', 
      worktreePath: '/test/worktree' 
    });
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err.message.includes('outside worktree'), 'Should throw about cwd outside worktree');
    console.log('  Throws correctly:', err.message.slice(0, 80), '\n');
  }

  console.log('All tests passed!');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
