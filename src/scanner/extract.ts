import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ParsedFile, GraphNode, GraphEdge, NodeLabel, NodeProperties } from '../types/index.js';

// ---------------------------------------------------------------------------
// Alias map: prefix (e.g. "@/") → absolute target directory
// ---------------------------------------------------------------------------

export type AliasMap = Record<string, string>;

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function nodeId(relativePath: string, name?: string): string {
  const key = name ? `${relativePath}::${name}` : relativePath;
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

export function edgeId(fromId: string, kind: string, toId: string): string {
  return crypto.createHash('sha256').update(`${fromId}:${kind}:${toId}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Entity classification
// ---------------------------------------------------------------------------

function classifyExport(
  name: string,
  kind: string,
  file: ParsedFile,
): { label: NodeLabel; properties: NodeProperties } | null {
  const isHook = /^use[A-Z]/.test(name);
  const isTypeOnly = kind === 'type' || kind === 'interface';

  if (isTypeOnly) {
    return { label: 'Type', properties: {} };
  }

  if (isHook) {
    return { label: 'Hook', properties: {} };
  }

  // Check if it's a component: function/const that could return JSX
  const isComponent =
    kind === 'function' ||
    kind === 'const' ||
    kind === 'class' ||
    kind === 'unknown';

  if (isComponent) {
    const isTsx = file.relativePath.endsWith('.tsx') || file.relativePath.endsWith('.jsx');
    const hasJsx = isTsx || file.jsxUsed.length > 0;

    // Heuristic: PascalCase function in a .tsx/.jsx file → component
    const isPascalCase = /^[A-Z]/.test(name);

    if (isPascalCase && hasJsx) {
      const isClient = file.directive === 'use client';
      const isServer = file.directive === 'use server';
      const properties: NodeProperties = { isClient, isServer, isIconComponent: false };
      return { label: 'Component', properties };
    }

    if (isPascalCase) {
      return { label: 'Component', properties: { isClient: file.directive === 'use client', isServer: file.directive === 'use server', isIconComponent: false } };
    }
  }

  // Default: utility
  return { label: 'Utility', properties: {} };
}

function isRouteFile(relativePath: string): boolean {
  const base = path.basename(relativePath, path.extname(relativePath));
  return base === 'page' || base === 'route';
}

function isLayoutFile(relativePath: string): boolean {
  const base = path.basename(relativePath, path.extname(relativePath));
  return base === 'layout';
}

function routePathFromFile(relativePath: string): string {
  // app/dashboard/settings/page.tsx → /dashboard/settings
  // src/app/dashboard/page.tsx → /dashboard
  let p = relativePath
    .replace(/^src\//, '')
    .replace(/^(app|pages)\//, '')
    .replace(/\/(page|route|layout|loading|error|not-found)\.(ts|tsx|js|jsx)$/, '')
    .replace(/\.(ts|tsx|js|jsx)$/, '');

  // Remove route group segments like (marketing)
  p = p.replace(/\([^)]+\)\//g, '');
  // Remove dynamic segment brackets for display: [slug] → [slug]
  return '/' + p;
}

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

export interface ExtractedFile {
  fileNodeId: string;
  nodes: GraphNode[];
  importEdges: Array<{ source: string; names: string[] }>; // raw, resolved later
}

export function extractFromFile(
  file: ParsedFile,
  zone: 'source' | 'route',
): ExtractedFile {
  const nodes: GraphNode[] = [];
  const importEdges: Array<{ source: string; names: string[] }> = [];

  const fileNodeId_ = nodeId(file.relativePath);

  // Always create a File node — gives DEFINES/IMPORTS edges a real navigable source
  const fileNode: GraphNode = {
    id: fileNodeId_,
    label: 'File',
    name: path.basename(file.relativePath),
    path: file.relativePath,
    startLine: 1,
    endLine: file.linesOfCode,
    isExported: false,
    contentHash: file.contentHash,
    properties: { linesOfCode: file.linesOfCode },
  };
  nodes.push(fileNode);

  // --- Route / Layout special handling ---
  if (zone === 'route') {
    if (isLayoutFile(file.relativePath)) {
      const layoutNode: GraphNode = {
        id: nodeId(file.relativePath, 'layout'),
        label: 'Layout',
        name: path.basename(path.dirname(file.relativePath)) || 'layout',
        path: file.relativePath,
        startLine: 1,
        endLine: file.linesOfCode,
        isExported: true,
        contentHash: file.contentHash,
        properties: {
          routerKind: file.relativePath.startsWith('pages/') || file.relativePath.startsWith('src/pages/') ? 'pages' : 'app',
        },
      };
      nodes.push(layoutNode);
    } else if (isRouteFile(file.relativePath)) {
      const routeNode: GraphNode = {
        id: nodeId(file.relativePath, 'route'),
        label: 'Route',
        name: routePathFromFile(file.relativePath),
        path: file.relativePath,
        startLine: 1,
        endLine: file.linesOfCode,
        isExported: true,
        contentHash: file.contentHash,
        properties: {
          routePath: routePathFromFile(file.relativePath),
          routerKind: file.relativePath.startsWith('pages/') || file.relativePath.startsWith('src/pages/') ? 'pages' : 'app',
          isClient: file.directive === 'use client',
          isServer: file.directive === 'use server',
        },
      };
      nodes.push(routeNode);
    }
  } else {
    // --- Source file: extract named exports as entities ---
    for (const exp of file.exports) {
      const classified = classifyExport(exp.name, exp.kind, file);
      if (!classified) continue;

      const id = nodeId(file.relativePath, exp.name);
      const node: GraphNode = {
        id,
        label: classified.label,
        name: exp.name,
        path: file.relativePath,
        startLine: exp.startLine,
        endLine: exp.endLine,
        isExported: true,
        contentHash: file.contentHash,
        properties: {
          ...classified.properties,
          linesOfCode: file.linesOfCode,
        },
      };
      nodes.push(node);
    }

    // If no exports were found but file has JSX, create a single Component node
    if (nodes.length === 0 && file.jsxUsed.length > 0) {
      const name = path.basename(file.relativePath, path.extname(file.relativePath));
      nodes.push({
        id: fileNodeId_,
        label: 'Component',
        name,
        path: file.relativePath,
        startLine: 1,
        endLine: file.linesOfCode,
        isExported: false,
        contentHash: file.contentHash,
        properties: {
          isClient: file.directive === 'use client',
          isServer: file.directive === 'use server',
          isIconComponent: false,
          linesOfCode: file.linesOfCode,
        },
      });
    }
  }

  // Collect raw imports for later resolution
  for (const imp of file.imports) {
    importEdges.push({ source: imp.source, names: imp.names });
  }

  return { fileNodeId: fileNodeId_, nodes, importEdges };
}

// ---------------------------------------------------------------------------
// Build DEFINES edges (file → entity)
// ---------------------------------------------------------------------------

export function buildDefinesEdges(fileId: string, nodes: GraphNode[]): GraphEdge[] {
  return nodes
    .filter((n) => n.id !== fileId) // don't self-reference route/layout nodes
    .map((n) => ({
      id: edgeId(fileId, 'DEFINES', n.id),
      fromId: fileId,
      toId: n.id,
      kind: 'DEFINES' as const,
      properties: {},
    }));
}

// ---------------------------------------------------------------------------
// Resolve import path to relative path
// ---------------------------------------------------------------------------

export function resolveImportPath(
  importSource: string,
  importerRelPath: string,
  projectRoot: string,
  aliases: AliasMap,
): string | null {
  const isRelative = importSource.startsWith('.');
  const matchedAlias = !isRelative
    ? Object.keys(aliases).find((p) => importSource.startsWith(p))
    : undefined;

  // External package — not a relative or alias import
  if (!isRelative && !matchedAlias) return null;

  let resolved: string;

  if (isRelative) {
    const dir = path.dirname(path.join(projectRoot, importerRelPath));
    resolved = path.resolve(dir, importSource);
  } else {
    // Alias import: strip the prefix and join with the mapped target dir
    const prefix = matchedAlias!;
    const targetDir = aliases[prefix]; // absolute path
    const rest = importSource.slice(prefix.length);
    resolved = path.join(targetDir, rest);
  }

  // Try with extensions — verify the file actually exists
  const exts = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  for (const ext of exts) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      const rel = path.relative(projectRoot, candidate);
      if (!rel.startsWith('..')) return rel;
    }
  }

  // Exact path (already has extension)
  if (fs.existsSync(resolved)) {
    const rel = path.relative(projectRoot, resolved);
    if (!rel.startsWith('..')) return rel;
  }

  return null;
}
