// P13–P16: Forge AST map, determinism, risk detection, EARS output (Requirement 3).
import { parse } from '@solidity-parser/parser';
import type { SourceUnit } from '@solidity-parser/parser/dist/src/ast-types';
import Ajv2020 from 'ajv/dist/2020.js';
import fc from 'fast-check';
import semver from 'semver';
import { describe, expect, it } from 'vitest';
import schema from '../../schema/ast-map.schema.json';
import { toAstMap } from '../../src/logic/ast-map';
import { canonicalJson } from '../../src/logic/canonical-json';
import { proposeInvariants } from '../../src/logic/invariants';
import { renderPlan } from '../../src/logic/plan';
import type { AstMap } from '../../src/logic/types';
import { renderSource, SHA, sourceModel, type SourceModel } from './solidity-gen';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);

const parseUnit = (src: string) => parse(src, { loc: true, range: true }) as SourceUnit;
const mapOf = (m: SourceModel): AstMap => toAstMap(parseUnit(renderSource(m)), { sourceName: 'Gen.sol', sha256: SHA });

/** Rebuilds every object with its keys in a shuffled order. */
function shuffleKeys(v: unknown, rnd: () => number): unknown {
  if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, rnd));
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [keys[i], keys[j]] = [keys[j]!, keys[i]!];
    }
    return Object.fromEntries(keys.map((k) => [k, shuffleKeys((v as Record<string, unknown>)[k], rnd)]));
  }
  return v;
}

/** Independent EARS checker (written separately from plan.ts). */
const EARS_INDEPENDENT: Record<string, RegExp> = {
  Ubiquitous: /^The (?!.*\b(?:WHEN|WHILE|IF|WHERE)\b)[^,]*? SHALL [^]*\.$/,
  'Event-driven': /^WHEN [^,]+, the [^,]+? SHALL [^]*\.$/,
  'State-driven': /^WHILE [^,]+, the [^,]+? SHALL [^]*\.$/,
  Unwanted: /^IF [^,]+, THEN the [^,]+? SHALL [^]*\.$/,
  Optional: /^WHERE [^,]+, the [^,]+? SHALL [^]*\.$/,
};

describe('forge AST map', () => {
  it('P13 ast-map-roundtrip [Req 3.3, 3.14]: map -> canonical JSON -> parse is lossless and schema-valid', () => {
    fc.assert(
      fc.property(sourceModel, (m) => {
        const map = mapOf(m);
        expect(JSON.parse(canonicalJson(map))).toEqual(map);
        const valid = validate(JSON.parse(canonicalJson(map)));
        if (!valid) throw new Error(ajv.errorsText(validate.errors));

        // Fidelity to the source model (Requirement 3.2).
        expect(map.contracts.map((c) => c.name)).toEqual(m.contracts.map((c) => c.name));
        m.contracts.forEach((cm, i) => {
          const c = map.contracts[i]!;
          expect(c.kind).toBe(cm.abstract ? 'abstract' : 'contract');
          expect(c.inherits).toEqual(cm.inherits);
          expect(c.pragma).toEqual(m.pragma === undefined ? [] : [m.pragma]);
          expect(c.stateVariables.map((v) => [v.name, v.type, v.visibility])).toEqual(cm.stateVars.map((v) => [v.name, v.type, v.visibility || 'internal']));
          expect(c.events.map((e) => [e.name, e.parameters])).toEqual(cm.events.map((e) => [e.name, e.params.map((p) => ({ name: p.name, type: p.type, indexed: p.indexed }))]));
          expect(c.modifiers.map((x) => x.name)).toEqual(cm.modifiers.map((x) => x.name));
          const fns = cm.functions.map((f) => ({
            name: f.name,
            kind: 'function',
            visibility: f.visibility,
            mutability: f.mutability || 'nonpayable',
            modifiers: f.modifiers,
            parameters: f.params.map((p) => ({ name: p.name, type: p.type })),
            returns: f.returns.map((p) => ({ name: p.name, type: p.type })),
          }));
          if (cm.receive) fns.push({ name: 'receive', kind: 'receive', visibility: 'external', mutability: 'payable', modifiers: [], parameters: [], returns: [] });
          expect(c.functions.map(({ loc: _loc, ...rest }) => rest)).toEqual(fns);
        });
      }),
    );
  });

  it('P14 forge-determinism [Req 3.12, 3.13]: output is byte-identical across runs and key-insertion orders', () => {
    fc.assert(
      fc.property(sourceModel, fc.integer(), (m, seed) => {
        const a = mapOf(m);
        const b = mapOf(m);
        const json = canonicalJson(a);
        expect(canonicalJson(b)).toBe(json);
        let s = seed >>> 0 || 1;
        const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
        expect(canonicalJson(shuffleKeys(a, rnd))).toBe(json);
        const p1 = renderPlan(a, proposeInvariants(a));
        const p2 = renderPlan(b, proposeInvariants(b));
        expect(p1).toEqual(p2);
      }),
    );
  });
});

describe('forge risk detection', () => {
  it('P15 risk-detection [Req 3.7]: injected R1–R4 patterns are flagged; R1–R2 have no false positives', () => {
    fc.assert(
      fc.property(sourceModel, (m) => {
        const map = mapOf(m);
        const has = (id: string, contract: string, fn?: string) =>
          map.risks.some((r) => r.id === id && r.contract === contract && (fn === undefined || r.function === fn));

        // R1: flagged iff the pragma admits a compiler below 0.8.0 (oracle: npm semver).
        const legacy = m.pragma === undefined || semver.intersects(m.pragma, '<0.8.0');
        for (const c of m.contracts) expect(has('legacy-pragma', c.name)).toBe(legacy);

        for (const c of m.contracts) {
          for (const f of c.functions) {
            // R2: flagged iff tx.origin is used for authorization.
            expect(has('tx-origin-auth', c.name, f.name)).toBe(f.body.includes('txorigin'));
            // R3: a discarded low-level call is flagged.
            if (f.body.includes('unchecked')) expect(has('unchecked-call', c.name, f.name)).toBe(true);
            // R4: a state write after an external call is flagged.
            if (f.body.includes('callThenWrite')) expect(has('call-before-write', c.name, f.name)).toBe(true);
          }
        }
      }),
      {
        // Regression: seed 713695097. A contract whose only state variable is a mapping.
        examples: [
          [
            {
              pragma: '>0.8 || >0.8.15',
              contracts: [
                {
                  abstract: false, inherits: [], token: false, events: [], modifiers: [], receive: false, name: 'C_1g',
                  stateVars: [{ type: 'mapping(address => uint256)', name: 's_', visibility: '' }],
                  functions: [{ name: 'f_', visibility: 'external', mutability: '', params: [], returns: [], modifiers: [], body: ['callThenWrite'] }],
                },
              ],
            },
          ],
        ],
      },
    );
  });
});

describe('forge plan', () => {
  it('P16 ears-only [Req 3.6]: every acceptance criterion in the generated requirements.md matches one EARS template', () => {
    fc.assert(
      fc.property(sourceModel, (m) => {
        const map = mapOf(m);
        const plan = renderPlan(map, proposeInvariants(map));
        if (!plan.ok) throw new Error(plan.error);
        const lines = plan.value.requirementsMd.split('\n');
        const criteria = lines.filter((l) => /^\d+\. \*\*/.test(l));
        expect(criteria.length).toBeGreaterThanOrEqual(m.contracts.length);
        for (const line of criteria) {
          const mm = /^\d+\. \*\*\d+\.\d+ \(([A-Za-z-]+)\)\*\* (.+)$/.exec(line);
          expect(mm, line).not.toBeNull();
          const [, pattern, text] = mm!;
          const re = EARS_INDEPENDENT[pattern!];
          expect(re, `unknown EARS pattern ${pattern}`).toBeDefined();
          expect(re!.test(text!), `${pattern}: ${text}`).toBe(true);
          expect((text!.match(/\bSHALL\b/g) ?? []).length).toBe(1);
        }
        // Token-like contracts get a balance invariant (Requirement 3.8).
        for (const c of m.contracts) {
          if (c.token) expect(proposeInvariants(map).some((i) => i.contract === c.name)).toBe(true);
        }
      }),
    );
  });
});
