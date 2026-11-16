#!/usr/bin/env node
// PBT guard: blocks a commit when files in a pure-core directory changed and
// that app's property-based tests fail.
//
// Modes:
//   --kiro  Kiro PreToolUse hook. Reads the hook event JSON on stdin, acts only
//           when the shell command contains `git commit`. Exit 2 blocks the tool.
//   --git   Git pre-commit hook (.githooks/pre-commit). Exit 1 blocks the commit.
//
// Fails closed: if watched files changed and the tests cannot run (for example
// vitest is not installed yet), the commit is blocked.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WATCHED = [
  { prefix: 'aegis-forge/src/logic/', app: 'aegis-forge' },
  { prefix: 'aegis-sentinel/src/core/', app: 'aegis-sentinel' },
];
const IGNORED_BASENAMES = new Set(['.gitkeep']);
const PBT_DIR = 'tests/pbt';

const mode = process.argv.includes('--git') ? 'git' : 'kiro';
const BLOCK_EXIT = mode === 'kiro' ? 2 : 1;
const log = (msg) => process.stderr.write(`${msg}\n`);

function gitLines(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Depth-first search for the first string value under a key named `command`.
function findCommand(node) {
  if (!node || typeof node !== 'object') return undefined;
  if (typeof node.command === 'string') return node.command;
  for (const value of Object.values(node)) {
    const found = findCommand(value);
    if (found) return found;
  }
  return undefined;
}

function isCommitCommand() {
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return false;
  }
  let command;
  try {
    command = findCommand(JSON.parse(raw));
  } catch {
    command = raw;
  }
  return typeof command === 'string' && /\bgit\b[^\n;&|]*\bcommit\b/.test(command);
}

function changedFiles() {
  const staged = gitLines(['diff', '--cached', '--name-only']);
  if (mode === 'git') return staged;
  // In Kiro mode the command may stage files itself (`git add x && git commit`),
  // so include unstaged and untracked changes too.
  return [
    ...staged,
    ...gitLines(['diff', '--name-only']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ];
}

function main() {
  if (mode === 'kiro' && !isCommitCommand()) return 0;

  const root = gitLines(['rev-parse', '--show-toplevel'])[0];
  if (!root) return 0;

  const files = [...new Set(changedFiles())].filter(
    (f) => !IGNORED_BASENAMES.has(f.split('/').pop()),
  );
  const apps = WATCHED.filter((w) => files.some((f) => f.startsWith(w.prefix)));
  if (apps.length === 0) return 0;

  const failures = [];
  for (const { app, prefix } of apps) {
    log(`[pbt-guard] Changes in ${prefix}. Running: vitest run ${PBT_DIR} (cwd ${app})`);
    const result = spawnSync('npx', ['--no-install', 'vitest', 'run', PBT_DIR], {
      cwd: join(root, app),
      stdio: ['ignore', 2, 2],
      env: { ...process.env, CI: '1' },
    });
    if (result.error || result.status !== 0) {
      failures.push(
        `${app}: ${result.error ? result.error.message : `vitest exited with code ${result.status}`}`,
      );
    }
  }

  if (failures.length === 0) {
    log('[pbt-guard] PBT suite passed. Commit allowed.');
    return 0;
  }
  log('[pbt-guard] COMMIT BLOCKED. Property-based tests failed or could not run:');
  for (const f of failures) log(`  - ${f}`);
  log('[pbt-guard] Fix the failing properties (see .kiro/steering/architecture.md) and retry.');
  return BLOCK_EXIT;
}

process.exit(main());
