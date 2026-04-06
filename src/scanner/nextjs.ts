import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import { nodeId, edgeId } from './extract.js';
import { upsertNode, upsertEdge, searchNodes } from '../db/index.js';

// ---------------------------------------------------------------------------
// Route tree — build LAYOUT_WRAPS + ROUTE_HANDLES edges
// ---------------------------------------------------------------------------

export function buildNextjsEdges(
  db: Database.Database,
  _projectRoot: string,
): void {
  const routes = searchNodes(db, { label: 'Route', limit: 1000 });
  const layouts = searchNodes(db, { label: 'Layout', limit: 200 });
  const components = searchNodes(db, { label: 'Component', limit: 5000 });

  // LAYOUT_WRAPS: each layout wraps routes/layouts that are nested under it
  for (const layout of layouts) {
    const layoutDir = path.dirname(layout.path);
    for (const route of routes) {
      const routeDir = path.dirname(route.path);
      if (routeDir.startsWith(layoutDir) && routeDir !== layoutDir) {
        upsertEdge(db, {
          id: edgeId(layout.id, 'LAYOUT_WRAPS', route.id),
          fromId: layout.id,
          toId: route.id,
          kind: 'LAYOUT_WRAPS',
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
          id: edgeId(layout.id, 'LAYOUT_WRAPS', nested.id),
          fromId: layout.id,
          toId: nested.id,
          kind: 'LAYOUT_WRAPS',
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
        id: edgeId(route.id, 'ROUTE_HANDLES', comp.id),
        fromId: route.id,
        toId: comp.id,
        kind: 'ROUTE_HANDLES',
        properties: {},
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Design token extraction from tailwind.config.ts
// ---------------------------------------------------------------------------

interface DesignTokenMap {
  [category: string]: { [name: string]: string };
}

export function extractDesignTokens(projectRoot: string): DesignTokenMap {
  const candidates = [
    'tailwind.config.ts',
    'tailwind.config.js',
    'tailwind.config.mjs',
  ];

  for (const candidate of candidates) {
    const fullPath = path.join(projectRoot, candidate);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const source = fs.readFileSync(fullPath, 'utf8');
      return parseTokensFromSource(source);
    } catch { /* skip */ }
  }

  return {};
}

function parseTokensFromSource(source: string): DesignTokenMap {
  const tokens: DesignTokenMap = {};
  const categories = ['colors', 'spacing', 'fontSize', 'fontFamily', 'borderRadius'];

  for (const cat of categories) {
    const catTokens: { [name: string]: string } = {};

    // Simple regex extraction — good enough for most configs
    const blockMatch = source.match(new RegExp(`${cat}\\s*:\\s*\\{([^}]+)\\}`, 's'));
    if (!blockMatch) continue;

    for (const m of blockMatch[1].matchAll(/'([^']+)'\s*:\s*['"]([^'"]+)['"]/g)) {
      catTokens[m[1]] = m[2];
    }
    for (const m of blockMatch[1].matchAll(/"([^"]+)"\s*:\s*['"]([^'"]+)['"]/g)) {
      catTokens[m[1]] = m[2];
    }

    if (Object.keys(catTokens).length > 0) tokens[cat] = catTokens;
  }

  return tokens;
}

export function writeDesignTokenNodes(
  db: Database.Database,
  tokens: DesignTokenMap,
): void {
  for (const [category, entries] of Object.entries(tokens)) {
    for (const [name, value] of Object.entries(entries)) {
      const fullName = `${category}.${name}`;
      const id = nodeId('design-token', fullName);
      upsertNode(db, {
        id,
        label: 'DesignToken',
        name: fullName,
        path: `tailwind.config`,
        startLine: 0,
        endLine: 0,
        isExported: false,
        contentHash: '',
        properties: { tokenCategory: category, tokenValue: value },
      });
    }
  }
}
