// Adapter (browser): the guarded config, the Forge invariants files, and the mock-chain fixture,
// bundled at build time as raw text. Provenance hashes are computed over the exact bytes, as
// adapters/config/load-guarded.ts does in Node, so both hosts report the same sha256.
// Validation lives in the pure core (core/config.ts).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '../../core/bytes';
import { invariantFilesOf, parseGuardedConfig, parseGuardSettings, type GuardedEntry, type GuardSettings } from '../../core/config';
import { err, ok, type Result } from '../../core/result';
import guardedText from '../../../config/guarded.json?raw';
import fixtureText from '../../../mcp/fixtures/mock-chain.json?raw';
import type { ChainFixture } from './mock-chain';

// Every Forge invariants file in the repo, keyed by repo-relative path (the form guarded.json uses).
const FORGE_PREFIX = '../../../../';
const forgeFiles = import.meta.glob<string>('../../../../aegis-forge/output/*.invariants.json', { query: '?raw', import: 'default', eager: true });

export interface BundledConfig {
  readonly entries: readonly GuardedEntry[];
  readonly settings: GuardSettings;
  readonly fixture: ChainFixture;
}

function parse(label: string, text: string): Result<unknown, string> {
  try {
    return ok(JSON.parse(text) as unknown);
  } catch (e) {
    return err(`${label}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function loadBundledConfig(): Result<BundledConfig, string> {
  const cfg = parse('config/guarded.json', guardedText);
  if (!cfg.ok) return cfg;
  const names = invariantFilesOf(cfg.value);
  if (!names.ok) return names;
  const files: Record<string, { json: unknown; sha256: string }> = {};
  for (const name of names.value) {
    const text = forgeFiles[FORGE_PREFIX + name];
    if (text === undefined) return err(`invariants_file ${name} is not bundled (only aegis-forge/output/*.invariants.json is)`);
    const json = parse(name, text);
    if (!json.ok) return json;
    files[name] = { json: json.value, sha256: bytesToHex(sha256(new TextEncoder().encode(text))).slice(2) };
  }
  const entries = parseGuardedConfig(cfg.value, files);
  if (!entries.ok) return entries;
  const settings = parseGuardSettings(cfg.value);
  if (!settings.ok) return settings;
  const fixture = parse('mcp/fixtures/mock-chain.json', fixtureText);
  if (!fixture.ok) return fixture;
  return ok({ entries: entries.value, settings: settings.value, fixture: fixture.value as ChainFixture });
}
