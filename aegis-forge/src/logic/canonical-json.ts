// Canonical JSON (Requirement 3.13): sorted keys, 2-space indent, trailing newline. Pure.

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

function sortKeys(v: unknown): Json {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new TypeError('canonicalJson: non-finite number');
    return v;
  }
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(v as object).sort()) {
      const child = (v as Record<string, unknown>)[k];
      if (child !== undefined) out[k] = sortKeys(child);
    }
    return out;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof v}`);
}

export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}
