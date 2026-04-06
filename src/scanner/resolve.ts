import * as fs from 'fs';
import * as path from 'path';
import type { GraphNode, GraphEdge } from '../types/index.js';
import { nodeId, edgeId, resolveImportPath, type AliasMap } from './extract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileRecord {
  relativePath: string;
  nodes: GraphNode[];
  rawImports: Array<{ source: string; names: string[] }>;
  reExports?: Array<{ source: string; names: string[] }>;
  jsxUsed?: string[];
}

// ---------------------------------------------------------------------------
// Build IMPORTS edges + RENDERS edges
// ---------------------------------------------------------------------------

export function resolveRelations(
  files: FileRecord[],
  projectRoot: string,
  aliases: AliasMap,
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  // Build a lookup: relativePath → file-level nodeId
  const pathToFileNodeId = new Map<string, string>();
  for (const f of files) {
    pathToFileNodeId.set(f.relativePath, nodeId(f.relativePath));
  }

  // Build a lookup: "relativePath::name" → entity nodeId (for named import resolution)
  const pathNameToNodeId = new Map<string, string>();
  // Build a lookup: exported name → node id (for RENDERS edges — global name match)
  const nameToNodeId = new Map<string, string>();
  for (const f of files) {
    for (const n of f.nodes) {
      pathNameToNodeId.set(`${f.relativePath}::${n.name}`, n.id);
      if (n.isExported) nameToNodeId.set(n.name, n.id);
    }
  }

  // Build a barrel re-export map: "barrelRelPath::exportedName" → entity nodeId
  // Handles: export { X } from './other' and export * from './other'
  // Only one level of indirection needed (barrel → direct definition file)
  const barrelNameToNodeId = new Map<string, string>();
  for (const f of files) {
    if (!f.reExports?.length) continue;
    for (const re of f.reExports) {
      const resolvedRel = resolveImportPath(re.source, f.relativePath, projectRoot, aliases);
      if (!resolvedRel) continue;

      if (re.names.length === 0) {
        // export * from '...' — re-export everything from that file
        for (const n of files.find((x) => x.relativePath === resolvedRel)?.nodes ?? []) {
          if (n.isExported && n.label !== 'File') {
            barrelNameToNodeId.set(`${f.relativePath}::${n.name}`, n.id);
          }
        }
      } else {
        // export { X, Y } from '...'
        for (const name of re.names) {
          const entityId =
            pathNameToNodeId.get(`${resolvedRel}::${name}`) ??
            barrelNameToNodeId.get(`${resolvedRel}::${name}`); // follow one more hop
          if (entityId) barrelNameToNodeId.set(`${f.relativePath}::${name}`, entityId);
        }
      }
    }
  }

  for (const f of files) {
    const fromId = nodeId(f.relativePath);

    for (const imp of f.rawImports) {
      const resolvedRel = resolveImportPath(
        imp.source,
        f.relativePath,
        projectRoot,
        aliases,
      );
      if (!resolvedRel) continue;
      if (!pathToFileNodeId.has(resolvedRel)) continue;

      // File-level IMPORTS edge (file → file)
      const fileToId = pathToFileNodeId.get(resolvedRel)!;
      edges.push({
        id: edgeId(fromId, 'IMPORTS', fileToId),
        fromId,
        toId: fileToId,
        kind: 'IMPORTS',
        properties: { importedNames: imp.names, resolvedPath: resolvedRel },
      });

      // Entity-level IMPORTS edges (file → specific entity node for each named import)
      // Falls back to barrel re-export map when the entity isn't directly defined there
      for (const name of imp.names) {
        if (!name || name.startsWith('* as')) continue;
        const entityId =
          pathNameToNodeId.get(`${resolvedRel}::${name}`) ??
          barrelNameToNodeId.get(`${resolvedRel}::${name}`);
        if (!entityId || entityId === fileToId) continue;
        edges.push({
          id: edgeId(fromId, 'IMPORTS', entityId),
          fromId,
          toId: entityId,
          kind: 'IMPORTS',
          properties: { importedNames: [name], resolvedPath: resolvedRel },
        });
      }
    }

    // RENDERS edges — PascalCase JSX children that match known component names
    // We attach these to the first Component/Hook node in the file
    const sourceNode = f.nodes.find((n) => n.label === 'Component' || n.label === 'Route' || n.label === 'Layout');
    if (!sourceNode) continue;

    // We need the parsed jsxUsed — pass it through FileRecord (added below)
    const jsxUsed = f.jsxUsed;
    if (!jsxUsed) continue;

    for (const usedName of jsxUsed) {
      const toId = nameToNodeId.get(usedName);
      if (!toId || toId === sourceNode.id) continue;
      edges.push({
        id: edgeId(sourceNode.id, 'RENDERS', toId),
        fromId: sourceNode.id,
        toId,
        kind: 'RENDERS',
        properties: {},
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Detect alias map from tsconfig compilerOptions.paths
// Returns: prefix (e.g. "@/") → absolute target directory
// ---------------------------------------------------------------------------

export function detectAliases(projectRoot: string): AliasMap {
  const aliases: AliasMap = {};

  try {
    const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
    const raw = fs.readFileSync(tsconfigPath, 'utf8');
    const tsconfig = JSON.parse(raw);
    if (typeof tsconfig !== 'object' || tsconfig === null) return aliases;
    const paths: Record<string, string[]> = tsconfig?.compilerOptions?.paths ?? {};
    const baseUrl: string = tsconfig?.compilerOptions?.baseUrl ?? '.';
    const baseDir = path.resolve(projectRoot, baseUrl);

    for (const [key, targets] of Object.entries(paths)) {
      if (!targets.length) continue;
      const prefix = key.replace(/\*$/, '');          // "@/*" → "@/"
      const targetGlob = targets[0].replace(/\*$/, ''); // "./src/*" → "./src/"
      const targetDir = path.resolve(baseDir, targetGlob);
      aliases[prefix] = targetDir;
    }
  } catch { /* no tsconfig or no paths */ }

  // Fallback: if no @/ alias found try common locations
  if (!aliases['@/']) {
    const candidates = [
      path.join(projectRoot, 'src'),
      projectRoot,
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { aliases['@/'] = c; break; }
    }
  }

  return aliases;
}

// ---------------------------------------------------------------------------
// Topological sort of files by import dependency
// (used for cross-file type propagation in future phases)
// ---------------------------------------------------------------------------

export function topologicalSort(files: FileRecord[], projectRoot: string, aliases: AliasMap): FileRecord[] {
  const relToFile = new Map<string, FileRecord>();
  for (const f of files) relToFile.set(f.relativePath, f);

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // file → files that import it

  for (const f of files) {
    inDegree.set(f.relativePath, 0);
    dependents.set(f.relativePath, []);
  }

  for (const f of files) {
    for (const imp of f.rawImports) {
      const resolved = resolveImportPath(imp.source, f.relativePath, projectRoot, aliases);
      if (!resolved || !relToFile.has(resolved)) continue;
      inDegree.set(f.relativePath, (inDegree.get(f.relativePath) ?? 0) + 1);
      dependents.get(resolved)!.push(f.relativePath);
    }
  }

  const queue = files.filter((f) => (inDegree.get(f.relativePath) ?? 0) === 0);
  const sorted: FileRecord[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const dep of dependents.get(current.relativePath) ?? []) {
      const newDegree = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) {
        const f = relToFile.get(dep);
        if (f) queue.push(f);
      }
    }
  }

  // Append any remaining (cycles)
  for (const f of files) {
    if (!sorted.includes(f)) sorted.push(f);
  }

  return sorted;
}
