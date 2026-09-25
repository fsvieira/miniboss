/**
 * Unit tests for AiClient
 * Usa mocks simples em vez de framework de teste
 */

const { AiClient } = require('./AiClient');

// ── Mocks ───────────────────────────────────────────────────────────────────

class MockOpenAI {
  constructor() {
    this.chat = {
      completions: {
        create: () => Promise.resolve({}) // Default mock
      }
    };
    this.models = {
      list: () => Promise.resolve({ data: [] }) // Default mock
    };
  }

  // Methods to configure mocks
  mockChatCompletion(response) {
    this.chat.completions.create = () => Promise.resolve(response);
  }

  mockChatCompletionError(error) {
    this.chat.completions.create = () => Promise.reject(error);
  }

  mockModelsList(response) {
    this.models.list = () => Promise.resolve(response);
  }

  mockModelsListError(error) {
    this.models.list = () => Promise.reject(error);
  }
}

// Mock do OpenAI SDK
const originalOpenAI = require('openai');
let mockOpenAIInstance = null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockClient(config = {}) {
  const defaultConfig = {
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com',
    ...config
  };

  // Criar cliente
  const client = new AiClient(defaultConfig);

  // Substituir o openai interno pelo mock
  mockOpenAIInstance = new MockOpenAI();
  client.openai = mockOpenAIInstance;

  return { client, mock: mockOpenAIInstance };
}

// ── Testes ──────────────────────────────────────────────────────────────────

async function testConstructor() {
  console.log('🧪 Testando construtor...');

  try {
    // Teste: construtor sem baseUrl deve falhar
    try {
      new AiClient({ apiKey: 'test' });
      throw new Error('Deveria ter falhado');
    } catch (error) {
      if (!error.message.includes('baseUrl is required')) {
        throw new Error('Incorrect validation error');
      }
    }

    // Teste: provider remoto sem apiKey deve falhar
    try {
      new AiClient({ baseUrl: 'https://api.openai.com/v1' });
      throw new Error('Deveria ter falhado');
    } catch (error) {
      if (!error.message.includes('apiKey is required for remote providers')) {
        throw new Error('Incorrect validation error');
      }
    }

    // Teste: provider local sem apiKey deve funcionar
    const localClient = new AiClient({
      baseUrl: 'http://localhost:1234/v1'
    });
    if (localClient.config.apiKey !== 'dummy') throw new Error('dummy apiKey not defined for local provider');

    // Test: valid constructor with apiKey
    const client = new AiClient({
      apiKey: 'test-key',
      baseUrl: 'https://test.com',
      timeout: 5000,
      maxRetries: 2
    });

    if (client.config.apiKey !== 'test-key') throw new Error('apiKey not defined');
    if (client.config.baseUrl !== 'https://test.com') throw new Error('baseUrl not defined');
    if (client.config.timeout !== 5000) throw new Error('timeout not defined');
    if (client.config.maxRetries !== 2) throw new Error('maxRetries not defined');

    console.log('✅ Construtor funciona');
    return true;
  } catch (error) {
    console.log('❌ Construtor falhou:', error.message);
    return false;
  }
}

async function testListModels() {
  console.log('🧪 Testando listModels...');

  const { client, mock } = createMockClient();

  // Mock da resposta
  mock.mockModelsList({
    data: [
      { id: 'gpt-4', object: 'model' },
      { id: 'gpt-3.5-turbo', object: 'model' }
    ]
  });

  try {
    const models = await client.listModels();

    if (!Array.isArray(models)) throw new Error('Deveria retornar array');
    if (models.length !== 2) throw new Error('Deveria retornar 2 modelos');
    if (models[0].id !== 'gpt-4') throw new Error('Primeiro modelo incorreto');

    console.log('✅ listModels funciona');
    return true;
  } catch (error) {
    console.log('❌ listModels falhou:', error.message);
    return false;
  } finally {
    client.close();
  }
}

async function testChatCompletionSuccess() {
  console.log('🧪 Testando chatCompletion (sucesso)...');

  const { client, mock } = createMockClient();

  // Mock da resposta
  mock.mockChatCompletion({
    choices: [{
      message: { content: 'Resposta de teste', tool_calls: null },
      finish_reason: 'stop'
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 }
  });

  try {
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 100
    });

    if (result.content !== 'Resposta de teste') throw new Error('Content incorreto');
    if (result.finishReason !== 'stop') throw new Error('Finish reason incorreto');
    if (result.usage.promptTokens !== 10) throw new Error('Usage incorreto');

    console.log('✅ chatCompletion sucesso funciona');
    return true;
  } catch (error) {
    console.log('❌ chatCompletion falhou:', error.message);
    return false;
  } finally {
    client.close();
  }
}

async function testChatCompletionRetry() {
  console.log('🧪 Testando chatCompletion (retry)...');

  const { client, mock } = createMockClient({ maxRetries: 2 });

  // Mock: primeira chamada falha com 429, segunda passa
  let callCount = 0;
  mock.chat.completions.create = () => {
    callCount++;
    if (callCount === 1) {
      return Promise.reject({ status: 429, headers: { get: () => '1' } });
    } else {
      return Promise.resolve({
        choices: [{
          message: { content: 'Response after retry', tool_calls: null },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      });
    }
  };

  try {
    const result = await client.chatCompletion({
      messages: [{ role: 'user', content: 'Hello' }]
    });

    if (callCount !== 2) throw new Error('Did not retry');
    if (result.content !== 'Response after retry') throw new Error('Retry did not work');

    console.log('✅ chatCompletion retry funciona');
    return true;
  } catch (error) {
    console.log('❌ chatCompletion retry falhou:', error.message);
    return false;
  } finally {
    client.close();
  }
}

// ── Executar Testes ──────────────────────────────────────────────────────────

async function runTests() {
  console.log('🚀 Running AiClient unit tests\n');

  const tests = [
    testConstructor,
    testListModels,
    testChatCompletionSuccess,
    testChatCompletionRetry,
  ];

  const results = [];
  for (const test of tests) {
    results.push(await test());
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n📊 Resultados: ${passed}/${results.length} testes passaram`);

  return passed === results.length;
}

// Executar se este ficheiro for executado diretamente
if (require.main === module) {
  runTests().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = {
  runTests,
  testConstructor,
  testListModels,
  testChatCompletionSuccess,
  testChatCompletionRetry,
};