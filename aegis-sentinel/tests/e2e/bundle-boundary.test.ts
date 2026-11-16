// Security boundary (Requirement 2.11): the browser bundle must never reach Node-only code that
// reads the environment or holds the signer key. Walks the static import graph from main.tsx.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SENTINEL = resolve(import.meta.dirname, '../..');
const ENTRY = resolve(SENTINEL, 'src/main.tsx');

// mcp/fixtures/*.json is public fixture data and may be bundled; the server code may not.
const FORBIDDEN_FILES = [/^src\/runtime\/sentinel\.ts$/, /^src\/adapters\/(chain|config|crypto)\//, /^mcp\/src\//, /^mcp\/[^/]+\.mjs$/, /^\.env/];
const FORBIDDEN_PACKAGES = [/^node:/, /^dotenv/, /^@modelcontextprotocol\//, /^ajv/, /^tsx/];
const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;

function resolveLocal(from: string, spec: string): string | undefined {
  const base = resolve(dirname(from), spec.replace(/\?.*$/, ''));
  for (const c of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) if (existsSync(c) && !c.endsWith('/')) return c;
  return undefined;
}

function graph(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const todo = [ENTRY];
  while (todo.length > 0) {
    const f = todo.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    if (!/\.tsx?$/.test(f)) continue;
    for (const m of readFileSync(f, 'utf8').matchAll(IMPORT)) {
      const spec = m[1] ?? m[2]!;
      if (spec.startsWith('.')) {
        const r = resolveLocal(f, spec);
        if (r) todo.push(r);
      } else packages.add(spec);
    }
  }
  return { files, packages };
}

describe('browser bundle boundary', () => {
  const g = graph();
  const rel = [...g.files].map((f) => relative(SENTINEL, f));

  it('includes the in-tab runtime (sanity check that the walk works)', () => {
    expect(rel).toContain('src/runtime/loop.ts');
    expect(rel).toContain('src/adapters/mock/mock-chain.ts');
  });

  it('never imports Node-only files', () => {
    expect(rel.filter((f) => FORBIDDEN_FILES.some((p) => p.test(f)))).toEqual([]);
  });

  it('never imports Node-only packages', () => {
    expect([...g.packages].filter((p) => FORBIDDEN_PACKAGES.some((r) => r.test(p)))).toEqual([]);
  });
});
