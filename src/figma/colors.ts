import * as fs from 'fs';

// ---------------------------------------------------------------------------
// CSS variable resolution
// ---------------------------------------------------------------------------

/**
 * Parse a CSS file and extract custom property declarations per selector block.
 * Returns a map of selector → (varName → value).
 * Common selectors: ':root', '.dark', '[data-theme="dark"]', etc.
 */
export function parseCssVarsBySelector(cssFilePath: string): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();
  let content: string;
  try {
    content = fs.readFileSync(cssFilePath, 'utf8');
  } catch {
    return result;
  }

  // Split into selector blocks by finding `selector { ... }`
  // We walk char-by-char to correctly handle nested braces
  let i = 0;
  while (i < content.length) {
    // Find next `{`
    const braceOpen = content.indexOf('{', i);
    if (braceOpen === -1) break;

    const selector = content.slice(i, braceOpen).trim();

    // Find matching closing `}`
    let depth = 1;
    let j = braceOpen + 1;
    while (j < content.length && depth > 0) {
      if (content[j] === '{') depth++;
      else if (content[j] === '}') depth--;
      j++;
    }
    const blockContent = content.slice(braceOpen + 1, j - 1);

    // Extract --var: value declarations from this block
    const varRe = /(--[\w-]+)\s*:\s*([^;}\n]+)/g;
    let m: RegExpExecArray | null;
    while ((m = varRe.exec(blockContent)) !== null) {
      const varName = m[1].trim();
      const value = m[2].trim();
      if (!result.has(selector)) result.set(selector, new Map());
      result.get(selector)!.set(varName, value);
    }

    i = j;
  }

  return result;
}

/**
 * Parse a CSS file and return ALL custom property declarations merged from all selectors.
 * Values from later selectors override earlier ones for the same var name.
 * This gives a superset covering both light and dark theme values.
 */
export function parseCssVars(cssFilePath: string): Map<string, string> {
  const bySelector = parseCssVarsBySelector(cssFilePath);
  const merged = new Map<string, string>();
  for (const [, vars] of bySelector) {
    for (const [k, v] of vars) merged.set(k, v);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// HSL → hex conversion
// ---------------------------------------------------------------------------

/**
 * Convert HSL (values: h 0-360, s 0-100, l 0-100) to a hex string.
 */
function hslToHex(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
}

/**
 * Parse an HSL string — supports:
 *   hsl(120, 50%, 50%)
 *   hsl(120 50% 50%)
 *   0 3% 6%   (bare H S% L% as used in Tailwind CSS var values)
 */
function parseHsl(value: string): { h: number; s: number; l: number } | null {
  // Strip hsl(...) wrapper if present
  const inner = value.replace(/^hsl\(\s*/, '').replace(/\s*\)$/, '');
  // Split by comma or space
  const parts = inner.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1]);
  const l = parseFloat(parts[2]);
  if (isNaN(h) || isNaN(s) || isNaN(l)) return null;
  return { h, s, l };
}

/**
 * Resolve a color value that may contain CSS variable references to a hex string.
 * e.g. "hsl(var(--neutral-200))" → looks up --neutral-200 in cssVars → resolves to hex.
 * Returns null if resolution fails.
 */
export function resolveColorToHex(value: string, cssVars: Map<string, string>): string | null {
  // Already a hex value
  if (/^#[0-9a-fA-F]{3,8}$/.test(value.trim())) return value.trim().toUpperCase();

  // Substitute all var(--x) references
  const resolved = value.replace(/var\((--[\w-]+)\)/g, (_, varName) => {
    return cssVars.get(varName) ?? '';
  });

  // Try to parse as HSL
  const hsl = parseHsl(resolved.trim());
  if (hsl) return hslToHex(hsl.h, hsl.s, hsl.l);

  return null;
}

// ---------------------------------------------------------------------------
// Resolve design-tokens color values using CSS vars
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Flatten token colors into a hex → token-name lookup map
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RGB helpers for approximate color matching
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return null;
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function colorDistance(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

export interface TokenEntry { hex: string; rgb: { r: number; g: number; b: number }; name: string }

/**
 * Walk resolved design tokens and build a list of { hex, rgb, name } entries.
 * Skips the top-level "colors" key and collapses "DEFAULT" segments.
 */
export function flattenTokenColors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tokens: Record<string, any>,
): TokenEntry[] {
  const entries: TokenEntry[] = [];
  const seen = new Set<string>();

  function walk(obj: Record<string, unknown>, path: string[]) {
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      const segment = key === 'DEFAULT' ? [] : [key];
      const nextPath = [...path, ...segment];

      if (typeof val === 'string' && /^#[0-9a-fA-F]{6}$/.test(val.trim())) {
        const hex = val.trim().toUpperCase();
        const name = nextPath.join('-') || key;
        if (!seen.has(hex)) {
          const rgb = hexToRgb(hex);
          if (rgb) { entries.push({ hex, rgb, name }); seen.add(hex); }
        }
      } else if (typeof val === 'object' && val !== null) {
        walk(val as Record<string, unknown>, nextPath);
      }
    }
  }

  const root = (tokens.colors && typeof tokens.colors === 'object')
    ? tokens.colors as Record<string, unknown>
    : tokens;
  walk(root, []);
  return entries;
}

/**
 * Find the closest token name for a given hex color using approximate RGB matching.
 * Returns null if no token is within the distance threshold (default: 10).
 */
export function findNearestToken(hex: string, entries: TokenEntry[], threshold = 10): string | null {
  const rgb = hexToRgb(hex.toUpperCase());
  if (!rgb) return null;
  let best: TokenEntry | null = null;
  let bestDist = Infinity;
  for (const entry of entries) {
    const d = colorDistance(rgb, entry.rgb);
    if (d < bestDist) { bestDist = d; best = entry; }
  }
  return best && bestDist <= threshold ? best.name : null;
}

/**
 * Walk a design tokens object and resolve any `hsl(var(...))` values to hex.
 * Mutates the object in place and returns it.
 */
export function resolveTokenColors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tokens: Record<string, any>,
  cssVars: Map<string, string>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Record<string, any> {
  for (const key of Object.keys(tokens)) {
    const val = tokens[key];
    if (typeof val === 'string') {
      if (val.includes('var(--') || /^hsl|^rgb/i.test(val)) {
        const hex = resolveColorToHex(val, cssVars);
        if (hex) tokens[key] = hex;
      }
    } else if (typeof val === 'object' && val !== null) {
      resolveTokenColors(val, cssVars);
    }
  }
  return tokens;
}
