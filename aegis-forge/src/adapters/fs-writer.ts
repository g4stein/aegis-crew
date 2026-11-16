// Adapter: writes ingest results. Never writes partial output (3.9) and never overwrites
// an existing spec without --force (3.10). Never touches the input file.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { IngestResult } from '../logic/ingest';
import { err, ok, type Result } from '../logic/result';

export async function readSource(path: string): Promise<Result<{ text: string; sha256: string }, string>> {
  try {
    const bytes = await readFile(path);
    return ok({ text: bytes.toString('utf8'), sha256: createHash('sha256').update(bytes).digest('hex') });
  } catch (e) {
    return err(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface OutputPaths {
  readonly astPath: string;
  readonly invariantsPath: string;
  readonly specDir: string;
}

export function outputPaths(result: IngestResult, outDir: string, specsDir: string): OutputPaths {
  return {
    astPath: join(outDir, `${result.name}.ast.json`),
    invariantsPath: join(outDir, `${result.name}.invariants.json`),
    specDir: join(specsDir, `${result.name}-modernization`),
  };
}

/** Writes everything to temporary paths first, then renames into place. */
export async function writeIngest(result: IngestResult, paths: OutputPaths, force: boolean): Promise<Result<OutputPaths, string>> {
  if (existsSync(paths.specDir) && !force) {
    return err(`${paths.specDir} already exists; refusing to overwrite (pass --force to replace it)`);
  }

  const tag = `.tmp-${process.pid}`;
  const tmpSpec = `${paths.specDir}${tag}`;
  const tmpAst = `${paths.astPath}${tag}`;
  const tmpInv = `${paths.invariantsPath}${tag}`;
  // With --force the existing spec is moved aside, not deleted, until the new one is in place,
  // so a failed write never leaves the user with neither version.
  const backup = `${paths.specDir}.bak-${process.pid}`;
  let movedAside = false;
  try {
    await mkdir(tmpSpec, { recursive: true });
    for (const [file, content] of Object.entries(result.specFiles)) await writeFile(join(tmpSpec, file), content);
    await mkdir(dirname(paths.astPath), { recursive: true });
    await writeFile(tmpAst, result.astJson);
    await writeFile(tmpInv, result.invariantsJson);

    if (force && existsSync(paths.specDir)) {
      await rename(paths.specDir, backup);
      movedAside = true;
    }
    await rename(tmpSpec, paths.specDir);
    await rename(tmpAst, paths.astPath);
    await rename(tmpInv, paths.invariantsPath);
    if (movedAside) await rm(backup, { recursive: true, force: true });
    return ok(paths);
  } catch (e) {
    await Promise.all([tmpSpec, tmpAst, tmpInv].map((p) => rm(p, { recursive: true, force: true })));
    if (movedAside) {
      await rm(paths.specDir, { recursive: true, force: true }).catch(() => undefined);
      await rename(backup, paths.specDir).catch(() => undefined);
    }
    return err(`write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
