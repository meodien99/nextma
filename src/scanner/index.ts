import * as path from 'path';
import * as fs from 'fs';
import type { ScanMeta } from '../types/index.js';
import { openDb, upsertNode, upsertEdge, upsertFileHash, getFileHash, deleteNodesByPath, deleteFileRecord, getAllFilePaths, saveScanMeta } from '../db/index.js';
import { discoverFiles, detectRouterKind, detectTypeScript } from './discover.js';
import { parseFile } from './parse.js';
import { extractFromFile, buildDefinesEdges } from './extract.js';
import { resolveRelations, detectAliases } from './resolve.js';
import { buildNextjsEdges, extractDesignTokens, writeDesignTokenNodes } from './nextjs.js';
import { computeImportanceScores } from './importance.js';

// ---------------------------------------------------------------------------
// Progress callback
// ---------------------------------------------------------------------------

export type ScanPhase =
  | 'discovering'
  | 'parsing'
  | 'extracting'
  | 'resolving'
  | 'nextjs'
  | 'scoring'
  | 'done';

export type ProgressCallback = (phase: ScanPhase, current: number, total: number, label?: string) => void;

// ---------------------------------------------------------------------------
// Scan options
// ---------------------------------------------------------------------------

export interface ScanOptions {
  incremental?: boolean;
  instructionFile?: string;
}

// ---------------------------------------------------------------------------
// Main scan entry point
// ---------------------------------------------------------------------------

export async function scan(
  projectRoot: string,
  outputDir: string,
  options: ScanOptions = {},
  onProgress?: ProgressCallback,
): Promise<ScanMeta> {
  const abs = path.resolve(projectRoot);
  const db = openDb(path.resolve(outputDir));
  const incremental = options.incremental ?? false;

  const progress = onProgress ?? (() => {});

  // ── 1. Discover files ────────────────────────────────────────────────────
  progress('discovering', 0, 1);
  const discovered = await discoverFiles(abs);
  progress('discovering', 1, 1);

  // ── 2. Incremental diff ──────────────────────────────────────────────────
  let filesToParse = discovered;

  if (incremental) {
    const existingPaths = new Set(getAllFilePaths(db));
    filesToParse = discovered.filter((f) => {
      const prevHash = getFileHash(db, f.relativePath);
      if (prevHash !== f.contentHash) {
        // Changed or new — delete old nodes first
        deleteNodesByPath(db, f.relativePath);
        deleteFileRecord(db, f.relativePath);
        return true;
      }
      existingPaths.delete(f.relativePath);
      return false;
    });

    // Removed files
    for (const removed of existingPaths) {
      deleteNodesByPath(db, removed);
      deleteFileRecord(db, removed);
    }
  } else {
    // Full scan — clear everything
    db.exec(`DELETE FROM nodes; DELETE FROM edges; DELETE FROM files; DELETE FROM meta;`);
  }

  // ── 3. Parse files (parallel, batched) ──────────────────────────────────
  const aliasPrefixes = detectAliases(abs);
  const BATCH = 50;
  const fileRecords: Array<{
    relativePath: string;
    nodes: ReturnType<typeof extractFromFile>['nodes'];
    rawImports: ReturnType<typeof extractFromFile>['importEdges'];
    reExports: import('../types/index.js').RawReExport[];
    jsxUsed: string[];
  }> = [];

  for (let i = 0; i < filesToParse.length; i += BATCH) {
    const batch = filesToParse.slice(i, i + BATCH);
    progress('parsing', i, filesToParse.length, `${i}/${filesToParse.length} files`);

    const results = await Promise.all(
      batch.map(async (f) => {
        const parsed = parseFile(f.absolutePath, f.relativePath, f.contentHash);
        if (!parsed) return null;
        const extracted = extractFromFile(parsed, f.zone);
        return { parsed, extracted };
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const { parsed, extracted } = result;

      // Write nodes
      for (const node of extracted.nodes) upsertNode(db, node);

      // Write DEFINES edges
      const definesEdges = buildDefinesEdges(extracted.fileNodeId, extracted.nodes);
      for (const edge of definesEdges) upsertEdge(db, edge);

      // Update file hash
      upsertFileHash(db, parsed.relativePath, parsed.contentHash);

      fileRecords.push({
        relativePath: parsed.relativePath,
        nodes: extracted.nodes,
        rawImports: extracted.importEdges,
        reExports: parsed.reExports,
        jsxUsed: parsed.jsxUsed,
      });
    }
  }

  progress('parsing', filesToParse.length, filesToParse.length);

  // ── 4. Resolve cross-file relations ─────────────────────────────────────
  progress('resolving', 0, 1);
  const relationEdges = resolveRelations(
    fileRecords.map((f) => ({ ...f, rawImports: f.rawImports })),
    abs,
    aliasPrefixes,
  );
  for (const edge of relationEdges) upsertEdge(db, edge);
  progress('resolving', 1, 1);

  // ── 5. Next.js-specific analysis ────────────────────────────────────────
  progress('nextjs', 0, 1);
  const tokens = extractDesignTokens(abs);
  writeDesignTokenNodes(db, tokens);
  buildNextjsEdges(db, abs);
  progress('nextjs', 1, 1);

  // ── 6. Importance scoring ────────────────────────────────────────────────
  progress('scoring', 0, 1);
  computeImportanceScores(db);
  progress('scoring', 1, 1);

  // ── 7. Save scan meta ────────────────────────────────────────────────────
  const nodeCount = (db.prepare(`SELECT COUNT(*) as c FROM nodes`).get() as { c: number }).c;
  const edgeCount = (db.prepare(`SELECT COUNT(*) as c FROM edges`).get() as { c: number }).c;

  const meta: ScanMeta = {
    projectRoot: abs,
    scannedAt: new Date().toISOString(),
    scanVersion: '2',
    totalNodes: nodeCount,
    totalEdges: edgeCount,
    routerKind: detectRouterKind(abs),
    hasTypeScript: detectTypeScript(abs),
  };
  saveScanMeta(db, meta);

  // ── 8. Write instruction file (opt-in) ──────────────────────────────────
  if (options.instructionFile) writeInstructionFile(abs, outputDir, options.instructionFile);

  progress('done', 1, 1);
  db.close();

  return meta;
}

// ---------------------------------------------------------------------------
// Write CLAUDE.md nextma instructions into the scanned project
// ---------------------------------------------------------------------------

function writeInstructionFile(projectRoot: string, outputDir: string, fileName: string): void {
  const claudePath = path.join(projectRoot, fileName);
  const contextDir = path.relative(projectRoot, path.resolve(outputDir)) || '.context';

  const block = `
## nextma MCP
A nextma knowledge graph is available for this project (\`${contextDir}/graph.db\`).
The following MCP tools are connected: recon, find_reusable, search_nodes, get_node, get_relations, get_route_tree, get_component_tree, get_boundary_map, detect_changes.

Before creating any new component, hook, or utility:
- Run \`recon("description")\` or \`find_reusable("description")\` first
- Read the source file of any top-ranked candidate before deciding to create a new one
- Only create something new if nothing suitable exists in the graph

Prefer these tools over file search when:
- Finding existing components, hooks, or utilities → \`recon("description")\` or \`find_reusable("description")\`
- Understanding component relationships or render trees → \`get_node(id)\`, \`get_component_tree(id)\`
- Checking server/client boundaries before adding hooks → \`get_boundary_map(routeId)\`
- Exploring the route structure → \`get_route_tree()\`
- Verifying the graph is up to date → \`detect_changes()\`

Fall back to reading source files when the graph result needs more detail.
`;

  if (fs.existsSync(claudePath)) {
    const existing = fs.readFileSync(claudePath, 'utf8');
    if (existing.includes('## nextma MCP')) {
      // Already present — replace the block
      const updated = existing.replace(
        /\n## nextma MCP[\s\S]*?(?=\n## |\n*$)/,
        block,
      );
      fs.writeFileSync(claudePath, updated);
    } else {
      fs.appendFileSync(claudePath, block);
    }
  } else {
    fs.writeFileSync(claudePath, `# Project Instructions${block}`);
  }
}
