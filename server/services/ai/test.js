/**
 * Basic AiClient test (not a formal unit test).
 * Use only for development/manual verification.
 */

const { AiClient } = require('./AiClient');

// Test configuration (replace with real values)
const testConfig = {
  apiKey: process.env.OPENAI_API_KEY || 'dummy-key',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-3.5-turbo',
  timeout: 30000,
  maxRetries: 1, // Few retries for testing
};

async function testListModels() {
    console.log('🧪 Testing listModels...');
  const client = new AiClient(testConfig);

  try {
    const models = await client.listModels();
    console.log('✅ listModels worked:', models.slice(0, 3));
    return true;
  } catch (error) {
    console.log('❌ listModels failed:', error.message);
    return false;
  } finally {
    client.close();
  }
}

async function testChatCompletion() {
    console.log('🧪 Testing chatCompletion...');
  const client = new AiClient(testConfig);

  try {
    const response = await client.chatCompletion({
      messages: [{ role: 'user', content: 'Hello, say only "test ok"' }],
      maxTokens: 50,
    });
    console.log('✅ chatCompletion worked:', {
      content: response.content?.substring(0, 50),
      finishReason: response.finishReason,
      usage: response.usage,
    });
    return true;
  } catch (error) {
    console.log('❌ chatCompletion failed:', error.message);
    return false;
  } finally {
    client.close();
  }
}

async function testChatCompletionStream() {
    console.log('🧪 Testing chatCompletionStream...');
  const client = new AiClient(testConfig);

  try {
    let chunksReceived = 0;
    await client.chatCompletionStream({
      messages: [{ role: 'user', content: 'Count from 1 to 3 slowly' }],
      maxTokens: 100,
    }, (chunk) => {
      chunksReceived++;
      if (chunk.type === 'delta') {
        process.stdout.write(chunk.content);
      } else if (chunk.type === 'finish') {
        console.log(`\n✅ Stream finished with ${chunksReceived} chunks`);
      }
    });
    return true;
  } catch (error) {
    console.log('❌ chatCompletionStream failed:', error.message);
    return false;
  } finally {
    client.close();
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  (async () => {
    console.log('🚀 Running basic AiClient tests\n');

    const results = await Promise.all([
      testListModels(),
      // testChatCompletion(),     // Desabilitado por default (custa dinheiro)
      // testChatCompletionStream(), // Desabilitado por default (custa dinheiro)
    ]);

    const passed = results.filter(Boolean).length;
    console.log(`\n📊 Resultados: ${passed}/${results.length} testes passaram`);
  })();
}

module.exports = {
  testListModels,
  testChatCompletion,
  testChatCompletionStream,
};