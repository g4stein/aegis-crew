// Adapter (Node): reads config/guarded.json and the Forge invariants files it names.
// Validation lives in the pure core (core/config.ts).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariantFilesOf, parseGuardedConfig, type GuardedEntry } from '../../core/config';
import { err, ok, type Result } from '../../core/result';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
export const DEFAULT_GUARDED_CONFIG = resolve(REPO_ROOT, 'aegis-sentinel/config/guarded.json');

function readJson(path: string): Result<{ json: unknown; sha256: string }, string> {
  try {
    const bytes = readFileSync(path);
    return ok({ json: JSON.parse(bytes.toString('utf8')) as unknown, sha256: createHash('sha256').update(bytes).digest('hex') });
  } catch (e) {
    return err(`cannot read ${relative(REPO_ROOT, path)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Loads and validates the guarded config. Invariants files must stay inside the repo. */
export function loadGuardedConfig(configPath = DEFAULT_GUARDED_CONFIG): Result<GuardedEntry[], string> {
  const cfg = readJson(configPath);
  if (!cfg.ok) return cfg;
  const files = invariantFilesOf(cfg.value.json);
  if (!files.ok) return files;
  const loaded: Record<string, { json: unknown; sha256: string }> = {};
  for (const f of files.value) {
    const abs = isAbsolute(f) ? f : resolve(REPO_ROOT, f);
    if (!abs.startsWith(REPO_ROOT + sep)) return err(`invariants_file ${f} is outside the repository`);
    const r = readJson(abs);
    if (!r.ok) return r;
    loaded[f] = r.value;
  }
  return parseGuardedConfig(cfg.value.json, loaded);
}
