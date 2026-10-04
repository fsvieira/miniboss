'use strict';

const assert = require('assert');
const ToolProcessor = require('../services/toolProcessor');

function createProcessor(rows) {
  const db = { getAllSandboxPaths: () => rows };
  const socket = {
    broadcastToConversation() {},
    broadcastToolStart() {},
    broadcastToolEnd() {}
  };
  return new ToolProcessor(db, socket);
}

function pathParts(env) {
  return env.PATH.split(':');
}

function runTests() {
  console.log('Running toolProcessor _buildRunEnv tests...\n');

  const originalPath = process.env.PATH;

  try {
    const configuredNoExport = '/home/user/.deno/bin';
    const configuredExport = '/home/user/.custom/bin';
    const unrelated = '/home/user/.unrelated/bin';

    process.env.PATH = [
      configuredNoExport,
      unrelated,
      '/usr/bin',
      '/bin'
    ].join(':');

    const rows = [
      { path: configuredNoExport, export_to_path: 0 },
      { path: configuredExport, export_to_path: 1 }
    ];

    const tp = createProcessor(rows);
    const parts = pathParts(tp._buildRunEnv());

    // 1. A configured path that is NOT exported is removed from the inherited PATH.
    assert.ok(
      !parts.includes(configuredNoExport),
      'configured non-exported path should be removed from PATH'
    );
    console.log('✅ removes configured path when export_to_path = 0');

    // 2. An exported configured path is appended even if it was not in the host PATH.
    assert.ok(
      parts.includes(configuredExport),
      'exported path should be present in PATH'
    );
    console.log('✅ appends configured path when export_to_path = 1');

    // 3. Unrelated host PATH entries are preserved.
    assert.ok(parts.includes(unrelated), 'unrelated host PATH entry should be preserved');
    console.log('✅ preserves unrelated host PATH entries');

    // 4. System directories are preserved.
    assert.ok(parts.includes('/usr/bin') && parts.includes('/bin'), 'system dirs should be preserved');
    console.log('✅ preserves system directories');

    // 5. A configured path that IS exported and already in the host PATH is kept once.
    process.env.PATH = [configuredNoExport, unrelated].join(':');
    const tp2 = createProcessor([{ path: configuredNoExport, export_to_path: 1 }]);
    const parts2 = pathParts(tp2._buildRunEnv());
    assert.ok(parts2.includes(configuredNoExport), 'exported path already in host PATH should be kept');
    assert.strictEqual(
      parts2.filter(p => p === configuredNoExport).length,
      1,
      'exported path should not be duplicated'
    );
    console.log('✅ keeps exported path already present without duplicating');

    // 6. System dir configured but not exported is still preserved.
    process.env.PATH = ['/usr/bin', unrelated].join(':');
    const tp3 = createProcessor([{ path: '/usr/bin', export_to_path: 0 }]);
    const parts3 = pathParts(tp3._buildRunEnv());
    assert.ok(parts3.includes('/usr/bin'), 'system dir must never be removed');
    console.log('✅ never removes a system directory even if configured without export');

    console.log('\nAll toolProcessor _buildRunEnv tests passed!');
  } finally {
    process.env.PATH = originalPath;
  }
}

runTests();
