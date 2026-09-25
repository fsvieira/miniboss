const assert = require('assert');
const { computeSafeMaxTokens, DEFAULT_TOKEN_LIMIT } = require('../controllers/tokenController');

function run(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('computeSafeMaxTokens:');

run('caps at 25% of context window (8192 -> 2048)', () => {
  assert.strictEqual(computeSafeMaxTokens(8192, 1000), 2048);
});

run('respects remaining space when input is very large', () => {
  const result = computeSafeMaxTokens(8000, 7500);
  assert.ok(result <= 400, `expected <= 400, got ${result}`);
});

run('never goes below 256', () => {
  const result = computeSafeMaxTokens(1000, 800);
  assert.ok(result >= 256, `expected >= 256, got ${result}`);
});

run('caps at defaultMax (8192) for large context window', () => {
  const result = computeSafeMaxTokens(200000, 1000);
  assert.strictEqual(result, 8192);
});

run('falls back to defaultMax when contextWindow is falsy', () => {
  assert.strictEqual(computeSafeMaxTokens(0, 1000), 8192);
  assert.strictEqual(computeSafeMaxTokens(null, 1000), 8192);
  assert.strictEqual(computeSafeMaxTokens(undefined, 1000), 8192);
  assert.strictEqual(computeSafeMaxTokens(-1, 1000), 8192);
});

run('respects custom defaultMax', () => {
  assert.strictEqual(computeSafeMaxTokens(100, 10, 4096), 256);
});

run('handles DEFAULT_TOKEN_LIMIT fallback scenario (32768 context, tiny input)', () => {
  const result = computeSafeMaxTokens(DEFAULT_TOKEN_LIMIT, 100);
  assert.strictEqual(result, 8192);
});
