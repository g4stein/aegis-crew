// Env hardening for the chain-state server (Requirement 2.11): an unexpanded "${VAR}" from
// the MCP host must never override the real value in .env.
import fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareEnv, unexpandedPlaceholders } from '../../mcp/src/env';

const dir = mkdtempSync(join(tmpdir(), 'aegis-env-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function dotenv(lines: Record<string, string>): string {
  const p = join(dir, `${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(p, Object.entries(lines).map(([k, v]) => `${k}=${v}`).join('\n'));
  return p;
}

describe('chain-state server env', () => {
  it('replaces a literal "${AEGIS_SIGNER_KEY}" with the value from .env', () => {
    const env: Record<string, string | undefined> = {
      AEGIS_SIGNER_KEY: '${AEGIS_SIGNER_KEY}',
      AEGIS_SIGNER_ACCOUNT_ID: '${AEGIS_SIGNER_ACCOUNT_ID}',
      AEGIS_CHAIN_MODE: 'mock',
    };
    const r = prepareEnv(env, dotenv({ AEGIS_SIGNER_KEY: 'ed25519:from_dotenv', AEGIS_SIGNER_ACCOUNT_ID: 'sentinel.testnet', AEGIS_CHAIN_MODE: 'live' }));
    expect(r.unset).toEqual(['AEGIS_SIGNER_ACCOUNT_ID', 'AEGIS_SIGNER_KEY']);
    expect(env.AEGIS_SIGNER_KEY).toBe('ed25519:from_dotenv');
    expect(env.AEGIS_SIGNER_ACCOUNT_ID).toBe('sentinel.testnet');
    // A real value set by the host still wins over .env.
    expect(env.AEGIS_CHAIN_MODE).toBe('mock');
  });

  it('leaves the variable unset when .env has no value for it', () => {
    const env: Record<string, string | undefined> = { AEGIS_SIGNER_KEY: '${AEGIS_SIGNER_KEY}' };
    const r = prepareEnv(env, join(dir, 'missing.env'));
    expect(r.dotenvLoaded).toBe(false);
    expect('AEGIS_SIGNER_KEY' in env).toBe(false);
  });

  it('property: a value is treated as unset iff it is a whole ${...} placeholder', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_ ]{0,16}$/), fc.constantFrom('', 'x', ' ', '$', '{'), fc.constantFrom('', 'x', ' ', '}'), (inner, pre, post) => {
        const v = `${pre}\${${inner}}${post}`;
        // `.*` may absorb a trailing "}", so "${x}}" also counts (seed 1905559858). Treating
        // it as unset is the safe direction: .env is consulted instead.
        const placeholder = pre === '' && (post === '' || post === '}');
        expect(unexpandedPlaceholders({ K: v })).toEqual(placeholder ? ['K'] : []);
      }),
      { examples: [['', '', '}']] },
    );
    fc.assert(
      fc.property(fc.dictionary(fc.stringMatching(/^[A-Z_]{1,12}$/), fc.string({ maxLength: 30 })), (env) => {
        const flagged = new Set(unexpandedPlaceholders(env));
        for (const [k, v] of Object.entries(env)) expect(flagged.has(k)).toBe(/^\$\{.*\}$/.test(v));
      }),
    );
  });
});
