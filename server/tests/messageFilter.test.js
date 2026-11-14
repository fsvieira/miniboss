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

  check('excludes a pending tool message from normalized history', () => {
    const messages = [{
      id: 10,
      role: 'tool',
      tool_call_id: 'call_pending',
      tool_name: 'readFile',
      status: 'pending',
      tool_result: null,
    }];
    const normalized = normalizeMessagesForLLM(messages);
    assert.strictEqual(normalized.length, 0, 'a pending tool must be dropped');
  });

  check('excludes a processing tool message from normalized history', () => {
    const messages = [{
      id: 11,
      role: 'tool',
      tool_call_id: 'call_processing',
      tool_name: 'readFile',
      status: 'processing',
      tool_result: null,
    }];
    const normalized = normalizeMessagesForLLM(messages);
    assert.strictEqual(normalized.length, 0, 'a processing tool must be dropped');
  });

  check('excludes a legacy tool message with no status and no result', () => {
    const messages = [{
      id: 12,
      role: 'tool',
      tool_call_id: 'call_legacy',
      tool_name: 'readFile',
      content: null,
      tool_result: null,
    }];
    const normalized = normalizeMessagesForLLM(messages);
    assert.strictEqual(normalized.length, 0, 'a legacy tool with no result must be dropped');
  });

  check('keeps a legacy tool message with no status but a result', () => {
    const messages = [{
      id: 13,
      role: 'tool',
      tool_call_id: 'call_legacy_done',
      tool_name: 'readFile',
      tool_result: '{"path":"/x","content":"ok"}',
    }];
    const normalized = normalizeMessagesForLLM(messages);
    assert.strictEqual(normalized.length, 1, 'a legacy tool with a result must be kept');
    assert.ok(normalized[0].content.includes('"path"'));
  });

  check('drops assistant tool_calls whose tool message is pending', () => {
    const messages = [
      {
        id: 20,
        role: 'assistant',
        content: 'Running a command',
        tool_calls: JSON.stringify([{ id: 'call_pending', type: 'function', function: { name: 'runCommand', arguments: '{}' } }]),
      },
      {
        id: 21,
        role: 'tool',
        tool_call_id: 'call_pending',
        tool_name: 'runCommand',
        status: 'pending',
        tool_result: null,
      },
    ];
    const normalized = normalizeMessagesForLLM(messages);
    assert.strictEqual(normalized.length, 1, 'the pending tool is dropped');
    assert.strictEqual(normalized[0].role, 'assistant');
    assert.ok(!('tool_calls' in normalized[0]), 'orphan tool_calls must be omitted');
  });

  check('keeps assistant tool_calls whose tool message completed', () => {
    const messages = [
      {
        id: 30,
        role: 'assistant',
        content: 'Ran a command',
        tool_calls: JSON.stringify([{ id: 'call_done', type: 'function', function: { name: 'runCommand', arguments: '{}' } }]),
      },
      {
        id: 31,
        role: 'tool',
        tool_call_id: 'call_done',
        tool_name: 'runCommand',
        status: 'processed',
        tool_result: '{"stdout":"ok","stderr":"","exitCode":0}',
      },
    ];
    const normalized = normalizeMessagesForLLM(messages);
    const assistant = normalized.find(m => m.role === 'assistant');
    assert.ok(assistant.tool_calls && assistant.tool_calls.length === 1, 'completed tool_calls must be kept');
    assert.strictEqual(assistant.tool_calls[0].id, 'call_done');
  });

  check('omits tool_calls when the assistant tool has no matching tool message', () => {
    const messages = [
      {
        id: 40,
        role: 'assistant',
        content: 'Called a tool that was never created',
        tool_calls: JSON.stringify([{ id: 'call_orphan', type: 'function', function: { name: 'runCommand', arguments: '{}' } }]),
      },
    ];
    const normalized = normalizeMessagesForLLM(messages);
    assert.strictEqual(normalized.length, 1);
    assert.ok(!('tool_calls' in normalized[0]), 'orphan tool_calls must be omitted');
  });

  check('mixes completed and pending tool_calls in one assistant', () => {
    const messages = [
      {
        id: 50,
        role: 'assistant',
        content: 'Two tools',
        tool_calls: JSON.stringify([
          { id: 'call_done2', type: 'function', function: { name: 'readFile', arguments: '{}' } },
          { id: 'call_pending2', type: 'function', function: { name: 'readFile', arguments: '{}' } },
        ]),
      },
      {
        id: 51,
        role: 'tool',
        tool_call_id: 'call_done2',
        tool_name: 'readFile',
        status: 'processed',
        tool_result: '{"path":"/x"}',
      },
      {
        id: 52,
        role: 'tool',
        tool_call_id: 'call_pending2',
        tool_name: 'readFile',
        status: 'pending',
        tool_result: null,
      },
    ];
    const normalized = normalizeMessagesForLLM(messages);
    const assistant = normalized.find(m => m.role === 'assistant');
    assert.ok(assistant.tool_calls && assistant.tool_calls.length === 1, 'only the completed tool_call is kept');
    assert.strictEqual(assistant.tool_calls[0].id, 'call_done2');
  });

  console.log(`\nAll messageFilter tests passed (${passed} checks).`);
}

runTests();
