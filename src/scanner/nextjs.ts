/* eslint-disable no-useless-assignment */
import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { nodeId, edgeId } from "./extract.js";
import { upsertNode, upsertEdge, searchNodes } from "../db/index.js";
import { parseCssVars, resolveColorToHex } from "../figma/colors.js";

// ---------------------------------------------------------------------------
// Route tree — build LAYOUT_WRAPS + ROUTE_HANDLES edges
// ---------------------------------------------------------------------------

export function buildNextjsEdges(
  db: Database.Database,
  _projectRoot: string,
): void {
  const routes = searchNodes(db, { label: "Route", limit: 1000 });
  const layouts = searchNodes(db, { label: "Layout", limit: 200 });
  const components = searchNodes(db, { label: "Component", limit: 5000 });

  // LAYOUT_WRAPS: each layout wraps routes/layouts that are nested under it
  for (const layout of layouts) {
    const layoutDir = path.dirname(layout.path);
    for (const route of routes) {
      const routeDir = path.dirname(route.path);
      if (routeDir.startsWith(layoutDir) && routeDir !== layoutDir) {
        upsertEdge(db, {
          id: edgeId(layout.id, "LAYOUT_WRAPS", route.id),
          fromId: layout.id,
          toId: route.id,
          kind: "LAYOUT_WRAPS",
          properties: {},
        });
      }
    }
    // Layout wraps nested layouts too
    for (const nested of layouts) {
      if (nested.id === layout.id) continue;
      const nestedDir = path.dirname(nested.path);
      if (nestedDir.startsWith(layoutDir) && nestedDir !== layoutDir) {
        upsertEdge(db, {
          id: edgeId(layout.id, "LAYOUT_WRAPS", nested.id),
          fromId: layout.id,
          toId: nested.id,
          kind: "LAYOUT_WRAPS",
          properties: {},
        });
      }
    }
  }

  // ROUTE_HANDLES: link each route to the default-exported component in the same file
  for (const route of routes) {
    const routeFile = route.path;
    const matching = components.filter(
      (c) => c.path === routeFile && c.isExported,
    );
    for (const comp of matching) {
      upsertEdge(db, {
        id: edgeId(route.id, "ROUTE_HANDLES", comp.id),
        fromId: route.id,
        toId: comp.id,
        kind: "ROUTE_HANDLES",
        properties: {},
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Design token extraction from tailwind.config.ts + CSS variable resolution
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Recursive JS object literal parser
// ---------------------------------------------------------------------------

function extractBlock(source: string, keyword: string): string | null {
  const re = new RegExp(`\\b${keyword}\\s*:\\s*\\{`);
  const match = re.exec(source);
  if (!match) return null;
  let depth = 1;
  let i = match.index + match[0].length;
  while (i < source.length && depth > 0) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") depth--;
    i++;
  }
  return depth === 0
    ? source.slice(match.index + match[0].length, i - 1)
    : null;
}

function readQuotedString(
  s: string,
  i: number,
): { value: string; end: number } | null {
  const q = s[i];
  if (q !== "'" && q !== '"') return null;
  let j = i + 1;
  while (j < s.length && s[j] !== q) {
    if (s[j] === "\\") j++;
    j++;
  }
  return { value: s.slice(i + 1, j), end: j + 1 };
}

function skipBalanced(s: string, i: number): number {
  const open = s[i],
    close = open === "{" ? "}" : "]";
  let depth = 1;
  i++;
  while (i < s.length && depth > 0) {
    if (s[i] === open) depth++;
    else if (s[i] === close) depth--;
    i++;
  }
  return i;
}

/**
 * Walk a JS/TS object literal block recursively.
 * Outputs flat entries: { 'neutral-300': 'hsl(var(--neutral-300))' }
 * Nested DEFAULT keys collapse to the parent name.
 * Array values are stored with an __array__ prefix for special handling.
 */
function walkBlock(
  block: string,
  prefix: string,
  out: Map<string, string>,
): void {
  let i = 0;
  while (i < block.length) {
    while (i < block.length && /[\s,]/.test(block[i])) i++;
    if (i >= block.length) break;

    // Skip JS comments
    if (block[i] === "/" && block[i + 1] === "/") {
      while (i < block.length && block[i] !== "\n") i++;
      continue;
    }
    if (block[i] === "/" && block[i + 1] === "*") {
      const end = block.indexOf("*/", i + 2);
      i = end === -1 ? block.length : end + 2;
      continue;
    }

    let key = "";
    if (block[i] === "'" || block[i] === '"') {
      const r = readQuotedString(block, i);
      if (!r) {
        i++;
        continue;
      }
      key = r.value;
      i = r.end;
    } else if (/[a-zA-Z_$\d]/.test(block[i])) {
      const start = i;
      while (i < block.length && /[\w-]/.test(block[i])) i++;
      key = block.slice(start, i);
    } else {
      i++;
      continue;
    }

    while (i < block.length && /\s/.test(block[i])) i++;
    if (i >= block.length || block[i] !== ":") continue;
    i++;
    while (i < block.length && /\s/.test(block[i])) i++;
    if (i >= block.length) break;

    const fullKey =
      key === "DEFAULT" ? prefix : prefix ? `${prefix}-${key}` : key;

    if (block[i] === "{") {
      const start = i + 1,
        end = skipBalanced(block, i);
      walkBlock(block.slice(start, end - 1), fullKey, out);
      i = end;
    } else if (block[i] === "[") {
      const start = i + 1,
        end = skipBalanced(block, i);
      out.set(`__array__${fullKey}`, block.slice(start, end - 1));
      i = end;
    } else if (block[i] === "'" || block[i] === '"') {
      const r = readQuotedString(block, i);
      if (!r) {
        i++;
        continue;
      }
      out.set(fullKey, r.value);
      i = r.end;
    } else {
      // bare value (e.g. unquoted hex)
      const start = i;
      while (i < block.length && !/[,\n}]/.test(block[i])) i++;
      const val = block.slice(start, i).trim();
      if (val && !val.startsWith("//")) out.set(fullKey, val);
    }
  }
}

// ---------------------------------------------------------------------------
// Color token extraction
// ---------------------------------------------------------------------------

interface ColorToken {
  name: string;
  rawValue: string;
  resolvedHex?: string;
}

function extractColorTokens(
  source: string,
  cssVars: Map<string, string>,
): ColorToken[] {
  const block = extractBlock(source, "colors");
  if (!block) return [];

  const raw = new Map<string, string>();
  walkBlock(block, "", raw);

  const tokens: ColorToken[] = [];
  for (const [name, rawValue] of raw) {
    if (name.startsWith("__array__")) continue;
    const resolvedHex = resolveColorToHex(rawValue, cssVars) ?? undefined;
    tokens.push({ name, rawValue, resolvedHex });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Typography token extraction
// ---------------------------------------------------------------------------

export interface FontSizeToken {
  name: string;
  fontSize: number;
  lineHeight?: number;
  fontWeight?: number;
}

function extractFontSizeTokens(source: string): FontSizeToken[] {
  const block = extractBlock(source, "fontSize");
  if (!block) return [];

  const raw = new Map<string, string>();
  walkBlock(block, "", raw);

  const tokens: FontSizeToken[] = [];
  for (const [key, val] of raw) {
    if (key.startsWith("__array__")) {
      // ['48px', { lineHeight: '64px', fontWeight: '400' }]
      const name = key.slice("__array__".length);
      const sizeMatch = val.match(/^['"]?([\d.]+)px['"]?/);
      if (!sizeMatch) continue;
      const fontSize = parseFloat(sizeMatch[1]);
      const lhMatch = val.match(/lineHeight\s*:\s*['"]?([\d.]+)(?:px)?['"]?/);
      const fwMatch = val.match(/fontWeight\s*:\s*['"]?(\d+)['"]?/);
      tokens.push({
        name,
        fontSize,
        lineHeight: lhMatch ? parseFloat(lhMatch[1]) : undefined,
        fontWeight: fwMatch ? parseInt(fwMatch[1]) : undefined,
      });
    } else {
      // simple string value like '48px'
      const px = parseFloat(val);
      if (!isNaN(px)) tokens.push({ name: key, fontSize: px });
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Locate globals.css
// ---------------------------------------------------------------------------

function findGlobalsCss(projectRoot: string): string | null {
  const candidates = [
    "app/globals.css",
    "app/global.css",
    "src/app/globals.css",
    "src/app/global.css",
    "styles/globals.css",
    "styles/global.css",
    "src/styles/globals.css",
  ];
  for (const c of candidates) {
    const p = path.join(projectRoot, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DesignTokens {
  colors: ColorToken[];
  fontSizes: FontSizeToken[];
}

export function extractDesignTokens(projectRoot: string): DesignTokens {
  const candidates = [
    "tailwind.config.ts",
    "tailwind.config.js",
    "tailwind.config.mjs",
  ];
  let source = "";

  for (const c of candidates) {
    const p = path.join(projectRoot, c);
    if (!fs.existsSync(p)) continue;
    try {
      source = fs.readFileSync(p, "utf8");
      break;
    } catch {
      /* skip */
    }
  }

  if (!source) return { colors: [], fontSizes: [] };

  // Load CSS vars for color resolution
  const cssPath = findGlobalsCss(projectRoot);
  const cssVars = cssPath ? parseCssVars(cssPath) : new Map<string, string>();

  return {
    colors: extractColorTokens(source, cssVars),
    fontSizes: extractFontSizeTokens(source),
  };
}

export function writeDesignTokenNodes(
  db: Database.Database,
  tokens: DesignTokens,
): void {
  for (const t of tokens.colors) {
    const id = nodeId("design-token", `colors.${t.name}`);
    upsertNode(db, {
      id,
      label: "DesignToken",
      name: `colors.${t.name}`,
      path: "tailwind.config",
      startLine: 0,
      endLine: 0,
      isExported: false,
      contentHash: "",
      properties: {
        tokenCategory: "colors",
        tokenValue: t.rawValue,
        resolvedHex: t.resolvedHex,
      },
    });
  }

  for (const t of tokens.fontSizes) {
    const id = nodeId("design-token", `fontSize.${t.name}`);
    upsertNode(db, {
      id,
      label: "DesignToken",
      name: `fontSize.${t.name}`,
      path: "tailwind.config",
      startLine: 0,
      endLine: 0,
      isExported: false,
      contentHash: "",
      properties: {
        tokenCategory: "fontSize",
        tokenValue: t.name,
        fontSize: t.fontSize,
        lineHeight: t.lineHeight,
        fontWeight: t.fontWeight,
      },
    });
  }
}
