const assert = require('assert');

const {
  formatConversationDeletionReport,
  buildDeletionReportPayload,
} = require('../services/conversationReport');

function baseReport(overrides = {}) {
  return {
    conversationId: 3,
    title: 'Fix env',
    mergeStatus: 'merged',
    isSafe: true,
    repoRoot: '/tmp/foo',
    baseBranch: 'main',
    gitBranch: 'fv/x',
    worktreePath: '/tmp/wt',
    changedFiles: 2,
    ahead: 1,
    behind: 0,
    hasUncommittedChanges: false,
    hasCommitsToMerge: false,
    deletedAt: '2026-09-21T10:00:00Z',
    outcome: 'deleted',
    summary: 'Conversation deleted after its tracked changes were committed and merged into the base branch.',
    ...overrides,
  };
}

const baseConversation = {
  id: 3,
  title: 'Fix env',
  conversation_type: 'main',
  repo_root: '/tmp/foo',
  base_branch: 'main',
  git_branch: 'fv/x',
  worktree_path: '/tmp/wt',
};

const baseProject = { id: 1, name: 'Test Project' };

function baseGitState(overrides = {}) {
  return {
    changedFiles: [{ staged: 'M', unstaged: '' }],
    ahead: 0,
    behind: 0,
    hasUncommittedChanges: false,
    hasCommitsToMerge: false,
    ...overrides,
  };
}

function testMergedUsesConciseStaticReport() {
  const md = formatConversationDeletionReport(baseReport());
  assert.ok(md.includes('A new piece of work was completed in the deleted conversation «Fix env»'), 'merged report states completed work');
  assert.ok(md.includes('This work was merged into main.'), 'merged report includes merged confirmation with base branch');
  assert.ok(md.includes('review whether project notes should be updated'), 'merged report includes review prompt');
  assert.ok(md.includes('create new notes to preserve useful context'), 'merged report includes create-notes prompt');
  assert.ok(md.includes('Question whether any existing notes still make sense'), 'merged report includes revision prompt');
  assert.ok(md.includes('- mergeStatus: merged'), 'mergeStatus present');
  assert.ok(!md.includes('aiReport'), 'merged report no longer injects AI-generated report body');
}

function testSimpleReportWhenNotMerged() {
  const md = formatConversationDeletionReport(
    baseReport({
      mergeStatus: 'unmerged',
      isSafe: false,
      hasCommitsToMerge: true,
      summary: 'Conversation deleted with uncommitted or unmerged work; local branch/worktree changes were discarded.',
    })
  );
  assert.ok(md.includes('A new piece of work was completed in the deleted conversation «Fix env»'), 'unmerged report states completed work');
  assert.ok(md.includes('This work was not merged and is considered discarded.'), 'unmerged report states discarded status');
  assert.ok(md.includes('review whether project notes should be updated'), 'unmerged report includes review prompt');
  assert.ok(md.includes('create new notes to preserve useful context'), 'unmerged report includes create-notes prompt');
  assert.ok(md.includes('Question whether any existing notes still make sense'), 'unmerged report includes revision prompt');
  assert.ok(md.includes('- mergeStatus: unmerged'), 'mergeStatus present in unmerged report');
  assert.ok(!md.includes('# Conversation deletion report'), 'unmerged report uses concise format without robust heading');
}

function testFallbackTitle() {
  const md = formatConversationDeletionReport(baseReport({ title: null }));
  assert.ok(md.includes('(untitled)'), 'fallback title used');
}

function testPayloadUncommittedChangesIsUnmerged() {
  const payload = buildDeletionReportPayload({
    conversation: baseConversation,
    project: baseProject,
    gitState: baseGitState({ hasUncommittedChanges: true }),
    outcome: 'deleted',
  });
  assert.strictEqual(payload.mergeStatus, 'unmerged');
  assert.strictEqual(payload.isSafe, false);
  assert.ok(payload.summary.includes('uncommitted or unmerged work'), 'summary explains work was discarded');
}

function testPayloadCommitsNotMergedIsUnmerged() {
  const payload = buildDeletionReportPayload({
    conversation: baseConversation,
    project: baseProject,
    gitState: baseGitState({ ahead: 3, hasCommitsToMerge: true }),
    outcome: 'deleted',
  });
  assert.strictEqual(payload.mergeStatus, 'unmerged');
  assert.strictEqual(payload.isSafe, false);
}

function testPayloadNullGitStateIsUnmerged() {
  const payload = buildDeletionReportPayload({
    conversation: baseConversation,
    project: baseProject,
    gitState: null,
    outcome: 'deleted',
  });
  assert.strictEqual(payload.mergeStatus, 'unmerged');
  assert.strictEqual(payload.isSafe, false);
}

function testPayloadCommittedAndMergedIsMerged() {
  const payload = buildDeletionReportPayload({
    conversation: baseConversation,
    project: baseProject,
    gitState: baseGitState(),
    outcome: 'deleted',
  });
  assert.strictEqual(payload.mergeStatus, 'merged');
  assert.strictEqual(payload.isSafe, true);
  assert.ok(payload.summary.includes('committed and merged'), 'summary confirms committed + merged');
}

const tests = [
  ['formatConversationDeletionReportMergedUsesConciseStaticReport', testMergedUsesConciseStaticReport],
  ['formatConversationDeletionReportMergedUsesConciseStaticReportFallbackCoverage', testMergedUsesConciseStaticReport],
  ['formatConversationDeletionReportSimpleWhenNotMerged', testSimpleReportWhenNotMerged],
  ['formatConversationDeletionReportFallbackTitle', testFallbackTitle],
  ['buildDeletionReportPayloadUncommittedIsUnmerged', testPayloadUncommittedChangesIsUnmerged],
  ['buildDeletionReportPayloadCommitsNotMergedIsUnmerged', testPayloadCommitsNotMergedIsUnmerged],
  ['buildDeletionReportPayloadNullGitStateIsUnmerged', testPayloadNullGitStateIsUnmerged],
  ['buildDeletionReportPayloadCommittedAndMergedIsMerged', testPayloadCommittedAndMergedIsMerged],
];

async function runTests() {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (error) {
      console.error(`❌ ${name}:`, error.message);
      console.error(error.stack);
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed.`);
  if (passed !== tests.length) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  runTests();
}

module.exports = { runTests };