#!/usr/bin/env node
// UI audit: flags code in aegis-sentinel that breaks .kiro/steering/ui-manifesto.md.
//
// Modes:
//   --kiro          Kiro PostToolUse hook. Reads the hook event JSON on stdin and
//                   audits the file(s) the write tool touched.
//   --all           Audit every tracked and untracked UI file in aegis-sentinel.
//   <file> [...]    Audit the given files.
//
// Exit 0 when clean, 1 when violations are found (the report goes to stderr,
// which Kiro forwards to the agent). Add `ui-audit-ignore` to a line to skip it.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const ALLOWED_HEX = new Set(['0a0a0a', 'f0f0f0', '1a1a1a', '8a8a8a', 'ccff00']);
const MAX_TRANSITION_MS = 80;

const LINE_RULES = [
  {
    id: 'gradient',
    re: /\b(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(|\bbg-gradient-|\b(?:from|via|to)-(?:purple|violet|indigo|blue|fuchsia)-\d{2,3}\b/i,
    msg: 'Gradients are forbidden.',
  },
  {
    id: 'glassmorphism',
    re: /backdrop-filter|backdropFilter|\bbackdrop-blur\b|filter\s*:\s*blur\(|\bblur-(?:sm|md|lg|xl|2xl|3xl)\b/,
    msg: 'Glassmorphism and blur are forbidden.',
  },
  {
    id: 'shadow',
    re: /\b(?:shadow|drop-shadow)-(?:sm|md|lg|xl|2xl|inner)\b|\bdrop-shadow\s*\(/,
    msg: 'Soft shadows are forbidden. Use 1px borders.',
  },
  {
    id: 'radius',
    re: /border-radius\s*:(?!\s*0(?:px|rem|em|%)?\s*(?:;|!|\}|$))|borderRadius\s*:(?!\s*0\s*[,}]|\s*['"]0(?:px)?['"])|(?<![\w-])rounded(?:-(?!none\b)[a-z0-9-]+)?(?![\w-])/,
    msg: 'border-radius must be 0.',
  },
  {
    id: 'icon-pack',
    re: /(?:from\s+|require\(\s*|import\s+)['"](?:lucide-react|lucide|react-icons(?:\/[^'"]*)?|@heroicons\/[^'"]+|heroicons|@phosphor-icons\/[^'"]+|@tabler\/icons-react)['"]/,
    msg: 'Icon libraries are forbidden. Use typographic glyphs or square-stroke inline SVG.',
  },
  {
    id: 'font-import',
    re: /@fontsource\/inter|fonts\.googleapis\.com|fonts\.gstatic\.com/,
    msg: 'Inter and runtime Google Fonts are forbidden. Self-host JetBrains Mono and Playfair Display.',
  },
  {
    id: 'easing',
    re: /cubic-bezier\(|\bease(?:-in-out|-in|-out)?\b(?=[\s;,)'"]|$)|type\s*:\s*['"]spring['"]|['"]framer-motion['"]|\banimate-bounce\b/,
    msg: 'Eased, springy, or bouncy motion is forbidden. Use transition: none, linear, or steps().',
  },
  {
    id: 'non-token-color',
    re: /\b(?:rgba?|hsla?|oklch|oklab)\s*\(/,
    msg: 'Use the color tokens (--obsidian, --off-white, --graphite, --ash, --acid), not raw color functions.',
  },
];

const FORBIDDEN_FONT = /\bInter\b|system-ui|-apple-system|BlinkMacSystemFont|\bRoboto\b|\bHelvetica\b|\bArial\b|Segoe UI|\bsans-serif\b/;

function auditLine(line) {
  const hits = [];
  for (const rule of LINE_RULES) {
    if (rule.re.test(line)) hits.push(`${rule.id}: ${rule.msg}`);
  }
  if (/font|family/i.test(line) && FORBIDDEN_FONT.test(line)) {
    hits.push('font: Inter and system sans are forbidden. Use JetBrains Mono (data) or Playfair Display (headings).');
  }
  for (const m of line.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g)) {
    let hex = m[1].toLowerCase();
    if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
    if (!ALLOWED_HEX.has(hex)) hits.push(`color: #${m[1]} is not a manifesto token.`);
  }
  const shadow = line.match(/box-shadow\s*:\s*([^;}]+)|boxShadow\s*:\s*['"`]([^'"`]+)['"`]/);
  if (shadow) {
    const value = (shadow[1] ?? shadow[2]).trim();
    if (value !== 'none') {
      // Split on commas outside parentheses, then read the third length (blur radius).
      const layers = value.split(/,(?![^(]*\))/);
      const soft = layers.some((layer) => {
        const lengths = layer
          .replace(/\binset\b/, '')
          .replace(/#[0-9a-fA-F]+|var\([^)]*\)|[a-z]+\([^)]*\)/g, '')
          .match(/-?\d*\.?\d+(?:px|rem|em)?/g) ?? [];
        return lengths.length >= 3 && parseFloat(lengths[2]) > 0;
      });
      if (soft) hits.push('shadow: box-shadow blur must be 0. Use 1px borders.');
    }
  }
  const isTransition = /transition/i.test(line);
  const isUnsteppedAnimation = /animation/i.test(line) && !/steps\(/.test(line);
  if (isTransition || isUnsteppedAnimation) {
    for (const m of line.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
      const ms = Number(m[1]) * (m[2] === 's' ? 1000 : 1);
      if (ms > MAX_TRANSITION_MS) hits.push(`motion: ${m[0]} exceeds ${MAX_TRANSITION_MS}ms.`);
    }
  }
  for (const m of line.matchAll(/\bduration-(\d+)\b/g)) {
    if (Number(m[1]) > MAX_TRANSITION_MS) hits.push(`motion: duration-${m[1]} exceeds ${MAX_TRANSITION_MS}ms.`);
  }
  return hits;
}

function inScope(rel) {
  if (!rel.startsWith('aegis-sentinel/')) return false;
  if (/\/(?:node_modules|dist|tests)\//.test(rel)) return false;
  if (/\.(?:tsx|jsx|css|scss|html)$/.test(rel)) return true;
  return rel.startsWith('aegis-sentinel/src/ui/') && rel.endsWith('.ts');
}

function auditFile(root, rel) {
  const abs = resolve(root, rel);
  if (!existsSync(abs)) return [];
  const findings = [];
  readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      if (line.includes('ui-audit-ignore')) return;
      for (const hit of auditLine(line)) findings.push(`${rel}:${i + 1}  ${hit}`);
    });
  return findings;
}

// Collect string values under path-like keys anywhere in the hook payload.
function collectPaths(node, out = new Set()) {
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (['path', 'file_path', 'filePath', 'targetFile'].includes(key) && typeof value === 'string') {
      out.add(value);
    } else if (key === 'paths' && Array.isArray(value)) {
      value.filter((v) => typeof v === 'string').forEach((v) => out.add(v));
    } else {
      collectPaths(value, out);
    }
  }
  return out;
}

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

function targets(root) {
  const args = process.argv.slice(2);
  if (args.includes('--kiro')) {
    let payload = {};
    try {
      payload = JSON.parse(readFileSync(0, 'utf8'));
    } catch {
      return [];
    }
    const base = typeof payload.cwd === 'string' ? payload.cwd : root;
    return [...collectPaths(payload)].map((p) => relative(root, isAbsolute(p) ? p : resolve(base, p)));
  }
  if (args.includes('--all')) {
    const list = (a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    return [
      ...list(['ls-files', 'aegis-sentinel']),
      ...list(['ls-files', '--others', '--exclude-standard', 'aegis-sentinel']),
    ];
  }
  return args.map((p) => relative(root, resolve(p)));
}

const root = repoRoot();
const files = [...new Set(targets(root))].filter(inScope);
const findings = files.flatMap((rel) => auditFile(root, rel));

if (findings.length > 0) {
  process.stderr.write(
    `[spec-audit] ${findings.length} UI manifesto violation(s). Fix them per .kiro/steering/ui-manifesto.md:\n` +
      findings.map((f) => `  ${f}`).join('\n') +
      '\n',
  );
  process.exit(1);
}
process.exit(0);
