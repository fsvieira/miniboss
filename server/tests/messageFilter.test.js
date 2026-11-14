'use strict';

const assert = require('assert');
const {
  normalizeMessagesForLLM,
  formatRunCommandToolContent,
} = require('../utils/messageFilter');

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

function runTests() {
  console.log('Running messageFilter tests...\n');

  check('formats a runCommand result as labelled text, omitting empty fields', () => {
    const text = formatRunCommandToolContent({ stdout: 'hello', stderr: '', exitCode: 0 });
    assert.strictEqual(text, 'exitCode: 0\nstdout:\nhello');
    assert.ok(!text.includes('stderr:'), 'an empty stderr must not produce a dangling label');
  });

  check('includes both fields when both have content', () => {
    const text = formatRunCommandToolContent({ stdout: 'out', stderr: 'err', exitCode: 7 });
    assert.strictEqual(text, 'exitCode: 7\nstdout:\nout\nstderr:\nerr');
  });

  check('flags an empty stdout with output on stderr', () => {
    const text = formatRunCommandToolContent({ stdout: '', stderr: 'boom', exitCode: 1 });
    assert.ok(text.includes('[stdout is empty; the output above is on stderr]'));
  });

  check('flags a command with no output at all', () => {
    const text = formatRunCommandToolContent({ stdout: '', stderr: '', exitCode: 0 });
    assert.ok(text.includes('[command produced no output]'));
  });

  check('surfaces a failed setup separately', () => {
    const text = formatRunCommandToolContent({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      setup: { status: 'failed', summary: 'apt failed' },
    });
    assert.ok(text.includes('[setup FAILED: apt failed]'));
  });

  check('drops internal diagnostics from the LLM payload', () => {
    const text = formatRunCommandToolContent({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      captureSource: 'file',
      sandboxed: true,
    });
    assert.ok(!text.includes('captureSource'));
    assert.ok(!text.includes('sandboxed'));
  });

  check('normalizeMessagesForLLM reformats runCommand results', () => {
    const messages = [{
      id: 1,
      role: 'tool',
      tool_name: 'runCommand',
      tool_result: JSON.stringify({ stdout: 'out', stderr: 'err', exitCode: 2, captureSource: 'file' }),
    }];
    const normalized = normalizeMessagesForLLM(messages);
    assert.strictEqual(normalized.length, 1);
    assert.ok(normalized[0].content.startsWith('exitCode: 2'));
    assert.ok(normalized[0].content.includes('stdout:\nout'));
    assert.ok(normalized[0].content.includes('stderr:\nerr'));
    assert.ok(!normalized[0].content.includes('captureSource'));
  });

  check('normalizeMessagesForLLM keeps other tool results as JSON', () => {
    const messages = [{
      id: 2,
      role: 'tool',
      tool_name: 'readFile',
      tool_result: JSON.stringify({ path: '/x', content: 'abc' }),
    }];
    const normalized = normalizeMessagesForLLM(messages);
    assert.ok(normalized[0].content.includes('"path"'));
  });

  console.log(`\nAll messageFilter tests passed (${passed} checks).`);
}

runTests();
