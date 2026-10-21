#!/usr/bin/env node
'use strict';

/**
 * Reproduction probe for the lost stdout (P9).
 *
 * `podman exec` intermittently returns an empty stdout with exit code 0 — the
 * assistant then runs blind. Two transports are compared:
 *
 *   --mode stream  the raw stream of `podman exec` (the behaviour before the
 *                  file transport). It attributes the loss to podman.
 *   --mode file    the file transport used by MiniBoss: the command writes
 *                  stdout/stderr/exit-code into the exchange directory and the
 *                  host reads the files back.
 *
 * The probe is the entry gate of the fix: the hypothesis ("podman loses the
 * output of `podman exec`") is only valid when the stream mode reproduces the
 * loss. When it does not, the hypothesis is wrong and the fix does nothing.
 *
 * Usage:
 *   node server/scripts/sandboxExecProbe.js --runs 20 --mode stream
 *   node server/scripts/sandboxExecProbe.js --runs 20 --mode file
 *
 * Acceptance:
 *   - `--mode stream` loses the output at least once (the "before" evidence);
 *   - `--mode file` never loses it.
 *
 * Exit code: 1 when the file mode loses output, 0 otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { runPodmanCommand, removeContainerForConversation } = require('../services/sandbox/podmanExecutor');
const { getSandboxConfig } = require('../services/sandbox/runtime');

const DEFAULT_COMMAND = "head -c 3000 /dev/zero | tr '\\0' 'a'";

/**
 * Parses the command line.
 * @param {string[]} argv
 * @returns {{runs: number, mode: string, command: string, keepContainer: boolean}}
 */
function parseArgs(argv) {
  const options = { runs: 20, mode: 'file', command: DEFAULT_COMMAND, keepContainer: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--runs' && argv[i + 1]) {
      options.runs = Math.max(1, parseInt(argv[i + 1], 10) || options.runs);
      i += 1;
    } else if (arg.startsWith('--runs=')) {
      options.runs = Math.max(1, parseInt(arg.slice('--runs='.length), 10) || options.runs);
    } else if (arg === '--mode' && argv[i + 1]) {
      options.mode = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice('--mode='.length);
    } else if (arg === '--command' && argv[i + 1]) {
      options.command = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--command=')) {
      options.command = arg.slice('--command='.length);
    } else if (arg === '--keep-container') {
      options.keepContainer = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    }
  }

  if (options.mode !== 'file' && options.mode !== 'stream') {
    throw new Error(`Unknown mode "${options.mode}" (expected "file" or "stream")`);
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log([
      'Usage: node server/scripts/sandboxExecProbe.js [options]',
      '',
      '  --runs N         number of executions (default: 20)',
      '  --mode MODE      "file" (MiniBoss transport) or "stream" (raw podman exec)',
      '  --command CMD    command to run (default: 3000 bytes of "a")',
      '  --keep-container do not remove the container at the end',
    ].join('\n'));
    return 0;
  }

  const config = getSandboxConfig();
  const conversationId = `probe-${process.pid}-${Date.now().toString(36)}`;
  const root = path.join(os.tmpdir(), `miniboss-sandbox-probe-${process.pid}`);
  const repoRoot = path.join(root, 'repo');
  const worktreePath = path.join(root, 'worktree');

  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });

  console.log('── Sandbox stdout probe ──');
  console.log(`Runtime: podman — image ${config.image}`);
  console.log(`Mode: ${options.mode} — runs: ${options.runs}`);
  console.log(`Command: ${options.command}\n`);

  const sandboxOpts = {
    repoRoot,
    worktreePath,
    conversationId,
    extraPaths: [],
    exportPaths: [],
    configuredPaths: [],
    captureMode: options.mode,
  };

  const results = [];

  try {
    for (let run = 1; run <= options.runs; run += 1) {
      const result = await runPodmanCommand(options.command, worktreePath, 30000, sandboxOpts);
      const stdout = String(result.stdout || '');
      const length = stdout.length;
      const truncated = stdout.endsWith('[truncated]');

      results.push({
        run,
        length,
        truncated,
        exitCode: result.exitCode,
        stderr: String(result.stderr || ''),
      });

      const flag = length === 0 ? '❌ EMPTY' : truncated ? '⚠️  TRUNC' : '   ok';
      console.log(
        `run ${String(run).padStart(3)}/${options.runs}  ${flag}  bytes=${length}  exit=${result.exitCode}` +
        (length === 0 && result.stderr ? `  stderr=${result.stderr.slice(0, 120)}` : '')
      );
    }
  } finally {
    if (!options.keepContainer) {
      try {
        removeContainerForConversation(conversationId);
      } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
    } else {
      console.log(`\nContainer kept: miniboss-${conversationId} (worktree: ${worktreePath})`);
    }
  }

  const lengths = results.map(r => r.length);
  const reference = lengths.length ? Math.max(...lengths) : 0;
  const empty = reference > 0 ? lengths.filter(l => l === 0).length : 0;
  // A truncated output is marked with `[truncated]`: a truncation that happens
  // on every run would be invisible in the length comparison.
  const marked = results.filter(r => r.truncated).length;
  const shorter = reference > 0 ? lengths.filter(l => l > 0 && l < reference).length : 0;
  const truncated = marked || shorter;
  const failed = results.filter(r => r.exitCode !== 0).length;
  const lossRate = reference > 0 ? Math.round((empty / results.length) * 100) : 0;

  console.log('\n── Summary ──');
  console.log(`mode:            ${options.mode}`);
  console.log(`runs:            ${results.length}`);
  console.log(`expected bytes:  ${reference}`);
  console.log(`empty outputs:   ${empty} (${lossRate}%)`);
  console.log(`truncated:       ${truncated} (${marked} marked with [truncated])`);
  console.log(`non-zero exit:   ${failed}`);

  if (reference === 0) {
    console.log('\nThe command produced no output at all — the probe is inconclusive.');
    return 1;
  }

  if (options.mode === 'file') {
    if (empty > 0) {
      console.log(`\n❌ The file transport lost the output ${empty} time(s) — the fix does not work.`);
      return 1;
    }
    console.log('\n✅ The file transport returned the output on every run.');
    return 0;
  }

  if (empty > 0) {
    console.log(`\n⚠️  The raw podman exec stream lost the output ${empty} time(s) — the loss is reproducible.`);
    console.log('   The file transport is the fix; re-run with --mode file to confirm it.');
    return 0;
  }

  console.log('\n⚠️  The raw podman exec stream did NOT lose the output.');
  console.log('   The hypothesis (podman relay) is not confirmed — stop and re-diagnose.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[sandboxExecProbe] Failed:', err && err.stack ? err.stack : err);
    process.exit(2);
  });
