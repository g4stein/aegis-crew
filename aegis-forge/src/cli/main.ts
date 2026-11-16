// Entry point: argument parsing and wiring only (architecture.md).
//
//   aegis-forge ingest [file.sol ...] [--out <dir>] [--specs-dir <dir>] [--force]
//
// With no file, ingests every aegis-forge/input/*.sol that has no spec directory yet (3.4).
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSolidity } from '../adapters/solidity-parser';
import { outputPaths, readSource, writeIngest } from '../adapters/fs-writer';
import { buildIngest, specName } from '../logic/ingest';

const FORGE_DIR = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const REPO_ROOT = resolve(FORGE_DIR, '..');
const INPUT_DIR = join(FORGE_DIR, 'input');

const USAGE = `Usage: aegis-forge ingest [file.sol ...] [--out <dir>] [--specs-dir <dir>] [--force]

  Parses legacy Solidity (never compiles or runs it) and writes:
    <out>/<name>.ast.json          JSON AST map and detected risks
    <out>/<name>.invariants.json   proposed invariants (Sentinel config format)
    <specs-dir>/<name>-modernization/{requirements,design,tasks}.md

  Defaults: --out aegis-forge/output   --specs-dir .kiro/specs
  With no file, ingests each aegis-forge/input/*.sol that has no spec yet.`;

interface Options {
  files: string[];
  outDir: string;
  specsDir: string;
  force: boolean;
}

/** npm run sets INIT_CWD to the directory the user ran the command from. */
const userCwd = () => process.env.INIT_CWD ?? process.cwd();
const fromUser = (p: string) => (isAbsolute(p) ? p : resolve(userCwd(), p));
const show = (p: string) => relative(REPO_ROOT, p) || '.';

function parseArgs(argv: string[]): Options | string {
  const o: Options = { files: [], outDir: join(FORGE_DIR, 'output'), specsDir: join(REPO_ROOT, '.kiro', 'specs'), force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--force') o.force = true;
    else if (a === '--out' || a === '--specs-dir') {
      const v = argv[++i];
      if (!v) return `${a} needs a value`;
      if (a === '--out') o.outDir = fromUser(v);
      else o.specsDir = fromUser(v);
    } else if (a.startsWith('--')) return `unknown option ${a}`;
    else o.files.push(fromUser(a));
  }
  return o;
}

function pendingInputs(specsDir: string): string[] {
  if (!existsSync(INPUT_DIR)) return [];
  return readdirSync(INPUT_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sol'))
    .sort()
    .filter((f) => !existsSync(join(specsDir, `${specName(f)}-modernization`)))
    .map((f) => join(INPUT_DIR, f));
}

async function ingestOne(file: string, o: Options): Promise<boolean> {
  const src = await readSource(file);
  if (!src.ok) {
    console.error(`error: ${src.error}`);
    return false;
  }
  const parsed = parseSolidity(src.value.text);
  if (!parsed.ok) {
    for (const e of parsed.error) console.error(`${show(file)}:${e.line}:${e.column} ${e.message}`);
    console.error(`error: ${show(file)} failed to parse; no files written`);
    return false;
  }
  const sourceName = file.replace(/^.*[\\/]/, '');
  const result = buildIngest(parsed.value, { sourceName, sha256: src.value.sha256 });
  if (!result.ok) {
    console.error(`error: ${result.error}; no files written`);
    return false;
  }
  const written = await writeIngest(result.value, outputPaths(result.value, o.outDir, o.specsDir), o.force);
  if (!written.ok) {
    console.error(`error: ${written.error}`);
    return false;
  }

  const { map, invariants } = result.value;
  console.log(`ingested ${show(file)} (sha256 ${src.value.sha256.slice(0, 12)}…)`);
  console.log(`  contracts   ${map.contracts.map((c) => c.name).join(', ')}`);
  console.log(`  risks       ${map.risks.length}${map.risks.length ? ` (${[...new Set(map.risks.map((r) => r.id))].join(', ')})` : ''}`);
  console.log(`  invariants  ${invariants.map((i) => `${i.contract}:${i.id}`).join(', ') || 'none'}`);
  console.log(`  wrote       ${show(written.value.astPath)}`);
  console.log(`              ${show(written.value.invariantsPath)}`);
  console.log(`              ${show(written.value.specDir)}/{requirements,design,tasks}.md`);
  return true;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command !== 'ingest') {
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  const o = parseArgs(rest);
  if (typeof o === 'string') {
    console.error(`error: ${o}\n\n${USAGE}`);
    return 2;
  }
  const files = o.files.length > 0 ? o.files : pendingInputs(o.specsDir);
  if (files.length === 0) {
    console.log('no new input: every aegis-forge/input/*.sol already has a spec');
    return 0;
  }
  let failed = 0;
  for (const f of files) if (!(await ingestOne(f, o))) failed++;
  return failed === 0 ? 0 : 1;
}
