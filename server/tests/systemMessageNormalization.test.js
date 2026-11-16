'use strict';

const assert = require('assert');
const { mergeSystemMessages } = require('../utils/messageFilter');
const { AiClient } = require('../services/ai/AiClient');

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

function makeClient() {
  return new AiClient({
    apiKey: 'test-key',
    baseUrl: 'http://localhost:1234/v1',
    model: 'test-model',
  });
}

function testMergeSystemMessages() {
  check('returns an empty array for empty input', () => {
    assert.deepStrictEqual(mergeSystemMessages([]), []);
    assert.deepStrictEqual(mergeSystemMessages(null), []);
  });

  check('leaves a history without system messages unchanged', () => {
    const input = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = mergeSystemMessages(input);
    assert.deepStrictEqual(out, input);
  });

  check('leaves a single leading system message unchanged', () => {
    const input = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ];
    assert.deepStrictEqual(mergeSystemMessages(input), input);
  });

  check('fuses two consecutive leading system messages into one at index 0', () => {
    const input = [
      { role: 'system', content: 'prompt' },
      { role: 'system', content: '[Current state]' },
      { role: 'user', content: 'hi' },
    ];
    const out = mergeSystemMessages(input);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].role, 'system');
    assert.strictEqual(out[0].content, 'prompt\n\n[Current state]');
    assert.deepStrictEqual(out[1], { role: 'user', content: 'hi' });
  });

  check('moves a system message found mid-history to the beginning', () => {
    const input = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'late' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = mergeSystemMessages(input);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].role, 'system');
    assert.strictEqual(out[0].content, 'prompt\n\nlate');
    assert.deepStrictEqual(out.slice(1), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  check('does not mutate the input array or its messages', () => {
    const input = [
      { role: 'system', content: 'prompt' },
      { role: 'system', content: 'state' },
      { role: 'user', content: 'hi' },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    mergeSystemMessages(input);
    assert.deepStrictEqual(input, snapshot);
  });

  check('is idempotent', () => {
    const input = [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'c' },
    ];
    const once = mergeSystemMessages(input);
    const twice = mergeSystemMessages(once);
    assert.deepStrictEqual(twice, once);
    assert.strictEqual(twice[0].content, 'a\n\nb\n\nc');
  });
}

async function testChatCompletionNormalization() {
  await checkAsync('chatCompletion sends a single system message at index 0', async () => {
    const client = makeClient();
    let captured = null;
    client.openai = {
      chat: {
        completions: {
          create: async (params) => {
            captured = params;
            return {
              model: 'test-model',
              choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
              usage: null,
            };
          },
        },
      },
    };

    await client.chatCompletion({
      messages: [
        { role: 'system', content: 'prompt' },
        { role: 'system', content: '[Current state]' },
        { role: 'user', content: 'hi' },
      ],
    });

    const systems = captured.messages.filter((m) => m.role === 'system');
    assert.strictEqual(systems.length, 1);
    assert.strictEqual(captured.messages[0].role, 'system');
    assert.strictEqual(captured.messages[0].content, 'prompt\n\n[Current state]');
  });
}

async function testChatCompletionStreamNormalization() {
  await checkAsync('chatCompletionStream sends a single system message at index 0', async () => {
    const client = makeClient();
    let captured = null;
    client.openai = {
      chat: {
        completions: {
          create: async (params) => {
            captured = params;
            return (async function* () {
              yield { model: 'test-model', choices: [{ delta: { content: 'ok' } }] };
              yield { model: 'test-model', choices: [{ delta: {}, finish_reason: 'stop' }] };
            })();
          },
        },
      },
    };

    await client.chatCompletionStream(
      {
        messages: [
          { role: 'system', content: 'prompt' },
          { role: 'user', content: 'hi' },
          { role: 'system', content: '[Current state]' },
        ],
      },
      () => {}
    );

    const systems = captured.messages.filter((m) => m.role === 'system');
    assert.strictEqual(systems.length, 1);
    assert.strictEqual(captured.messages[0].role, 'system');
    assert.strictEqual(captured.messages[0].content, 'prompt\n\n[Current state]');
  });
}

async function run() {
  console.log('Running systemMessageNormalization tests...\n');
  testMergeSystemMessages();
  await testChatCompletionNormalization();
  await testChatCompletionStreamNormalization();
  console.log(`\n${passed} test(s) passed.`);
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
