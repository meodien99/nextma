import Database from 'better-sqlite3';
import {
  searchNodes,
  getNodeById,
  getEdgesFrom,
  getEdgesTo,
  getScanMeta,
} from '../db/index.js';
import { scan } from '../scanner/index.js';
import type { GraphNode } from '../types/index.js';

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// Query tokenization — strips noise words, splits on common separators
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or',
  'is', 'it', 'as', 'by', 'be', 'ui', 'new', 'get', 'set', 'use',
]);

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s\-_/.,]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function scanRepo(db: Database.Database, projectRoot: string, outputDir: string, incremental: boolean) {
  return async () => {
    try {
      const meta = await scan(projectRoot, outputDir, { incremental });
      return ok({ success: true, ...meta });
    } catch (e) {
      return err(String(e));
    }
  };
}

export function searchNodesTool(db: Database.Database) {
  return (args: { label?: string; namePattern?: string; pathPattern?: string; limit?: number }) => {
    try {
      const nodes = searchNodes(db, args);
      return ok(nodes.map(nodeToSummary));
    } catch (e) {
      return err(String(e));
    }
  };
}

export function getNodeTool(db: Database.Database) {
  return (args: { id: string }) => {
    const node = getNodeById(db, args.id);
    if (!node) return err(`Node ${args.id} not found`);
    const outEdges = getEdgesFrom(db, args.id);
    const inEdges = getEdgesTo(db, args.id);
    return ok({ node, outEdges, inEdges });
  };
}

export function getRelationsTool(db: Database.Database) {
  return (args: { id: string; direction?: 'from' | 'to' | 'both'; kind?: string }) => {
    const { id, direction = 'both', kind } = args;
    const result: { from: unknown[]; to: unknown[] } = { from: [], to: [] };
    if (direction === 'from' || direction === 'both') result.from = getEdgesFrom(db, id, kind);
    if (direction === 'to' || direction === 'both') result.to = getEdgesTo(db, id, kind);
    return ok(result);
  };
}

export function getRouteTreeTool(db: Database.Database) {
  return () => {
    const routes = searchNodes(db, { label: 'Route', limit: 500 });
    const layouts = searchNodes(db, { label: 'Layout', limit: 100 });

    const tree = layouts.map((layout) => {
      const wrapsEdges = getEdgesFrom(db, layout.id, 'LAYOUT_WRAPS');
      const children = wrapsEdges.map((e) => {
        const child = getNodeById(db, e.toId);
        return child ? { id: child.id, name: child.name, label: child.label, path: child.path } : null;
      }).filter(Boolean);
      return { id: layout.id, name: layout.name, path: layout.path, children };
    });

    const wrappedIds = new Set(
      layouts.flatMap((l) => getEdgesFrom(db, l.id, 'LAYOUT_WRAPS').map((e) => e.toId))
    );
    const rootRoutes = routes
      .filter((r) => !wrappedIds.has(r.id))
      .map(nodeToSummary);

    return ok({ layouts: tree, rootRoutes });
  };
}

export function getComponentTreeTool(db: Database.Database) {
  return (args: { id: string; depth?: number }) => {
    const { id, depth = 3 } = args;

    function buildTree(nodeId: string, currentDepth: number): unknown {
      if (currentDepth === 0) return null;
      const node = getNodeById(db, nodeId);
      if (!node) return null;
      const rendersEdges = getEdgesFrom(db, nodeId, 'RENDERS');
      const children = rendersEdges
        .map((e) => buildTree(e.toId, currentDepth - 1))
        .filter(Boolean);
      return { ...nodeToSummary(node), children };
    }

    return ok(buildTree(id, depth));
  };
}

export function getBoundaryMapTool(db: Database.Database) {
  return (args: { routeId: string }) => {
    const visited = new Set<string>();
    const result: Array<{ id: string; name: string; path: string; isClient: boolean; isServer: boolean }> = [];

    function traverse(nodeId: string) {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = getNodeById(db, nodeId);
      if (!node) return;
      const props = node.properties;
      result.push({
        id: node.id,
        name: node.name,
        path: node.path,
        isClient: props.isClient ?? false,
        isServer: props.isServer ?? false,
      });
      for (const edge of getEdgesFrom(db, nodeId, 'RENDERS')) traverse(edge.toId);
      for (const edge of getEdgesFrom(db, nodeId, 'ROUTE_HANDLES')) traverse(edge.toId);
    }

    traverse(args.routeId);
    return ok(result);
  };
}

export function findReusableTool(db: Database.Database) {
  return (args: { query: string; limit?: number }) => {
    const words = tokenize(args.query);
    if (words.length === 0) return ok([]);
    const limit = args.limit ?? 15;

    const candidates = [
      ...searchNodes(db, { label: 'Component', limit: 1000 }),
      ...searchNodes(db, { label: 'Hook', limit: 500 }),
      ...searchNodes(db, { label: 'Utility', limit: 500 }),
    ];

    const scored = candidates.map((node) => {
      const target = `${node.name} ${node.path}`.toLowerCase();
      const importance = node.properties.importanceScore ?? 0;

      // Direct name/path match
      const directOverlap = words.filter((w) => target.includes(w)).length;
      const directScore = directOverlap / words.length;

      // Relationship-aware: check if dependencies also match the query
      const depEdges = [
        ...getEdgesFrom(db, node.id, 'CALLS'),
        ...getEdgesFrom(db, node.id, 'RENDERS'),
        ...getEdgesFrom(db, node.id, 'IMPORTS'),
      ];
      let depScore = 0;
      for (const edge of depEdges) {
        const dep = getNodeById(db, edge.toId);
        if (!dep) continue;
        const depTarget = `${dep.name} ${dep.path}`.toLowerCase();
        const depOverlap = words.filter((w) => depTarget.includes(w)).length;
        if (depOverlap > 0) depScore = Math.max(depScore, depOverlap / words.length * 0.5);
      }

      // Partial/prefix matching for camelCase names
      // e.g. "balance" matches "useTokenBalance", "BalanceDisplay"
      const partialOverlap = words.filter((w) => {
        const segments = node.name.replace(/([A-Z])/g, ' $1').toLowerCase();
        return segments.includes(w);
      }).length;
      const partialScore = partialOverlap / words.length * 0.7;

      const finalScore =
        Math.max(directScore, partialScore) * 0.6 +
        depScore * 0.2 +
        importance * 0.2;

      return { node, score: finalScore };
    })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return ok(scored.map((s) => ({
      ...nodeToSummary(s.node),
      score: Math.round(s.score * 100) / 100,
    })));
  };
}

export function detectChangesTool(db: Database.Database) {
  return () => {
    const meta = getScanMeta(db);
    return ok({ lastScan: meta?.scannedAt ?? null, message: 'Run nextma refresh to re-scan' });
  };
}

export function figmaMatchesTool(db: Database.Database) {
  return (args: { slug: string }) => {
    const figmaNodes = searchNodes(db, { label: 'FigmaNode', namePattern: args.slug, limit: 10 });
    if (figmaNodes.length === 0) return ok({ matches: [], message: `No FigmaNode found for slug "${args.slug}"` });

    const figmaNode = figmaNodes[0];
    const edges = getEdgesFrom(db, figmaNode.id, 'FIGMA_MAPS_TO');
    const matches = edges.map((e) => {
      const target = getNodeById(db, e.toId);
      return target ? nodeToSummary(target) : null;
    }).filter(Boolean);

    return ok({ figmaNode: nodeToSummary(figmaNode), matches });
  };
}

// ---------------------------------------------------------------------------
// recon — pre-task chain: find_reusable + get_node + get_component_tree + get_boundary_map
// ---------------------------------------------------------------------------

export function reconTool(db: Database.Database) {
  return (args: { query: string; routeId?: string; depth?: number }) => {
    const { query, routeId, depth = 2 } = args;

    // Step 1: find top candidates
    const words = tokenize(query);
    if (words.length === 0) return ok({ candidates: [], boundaryMap: null });

    const candidates = [
      ...searchNodes(db, { label: 'Component', limit: 1000 }),
      ...searchNodes(db, { label: 'Hook', limit: 500 }),
      ...searchNodes(db, { label: 'Utility', limit: 500 }),
    ];

    const scored = candidates.map((node) => {
      const target = `${node.name} ${node.path}`.toLowerCase();
      const importance = node.properties.importanceScore ?? 0;
      const directOverlap = words.filter((w) => target.includes(w)).length;
      const directScore = directOverlap / words.length;
      const depEdges = [
        ...getEdgesFrom(db, node.id, 'CALLS'),
        ...getEdgesFrom(db, node.id, 'RENDERS'),
      ];
      let depScore = 0;
      for (const edge of depEdges) {
        const dep = getNodeById(db, edge.toId);
        if (!dep) continue;
        const depTarget = `${dep.name} ${dep.path}`.toLowerCase();
        const depOverlap = words.filter((w) => depTarget.includes(w)).length;
        if (depOverlap > 0) depScore = Math.max(depScore, depOverlap / words.length * 0.5);
      }
      const partialOverlap = words.filter((w) => {
        const segments = node.name.replace(/([A-Z])/g, ' $1').toLowerCase();
        return segments.includes(w);
      }).length;
      const partialScore = partialOverlap / words.length * 0.7;
      const finalScore = Math.max(directScore, partialScore) * 0.6 + depScore * 0.2 + importance * 0.2;
      return { node, score: finalScore };
    })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Step 2: for each top candidate, fetch full shape + render tree
    const enriched = scored.map(({ node, score }) => {
      const outEdges = getEdgesFrom(db, node.id);
      const inEdges = getEdgesTo(db, node.id);

      function buildTree(nodeId: string, currentDepth: number): unknown {
        if (currentDepth === 0) return null;
        const n = getNodeById(db, nodeId);
        if (!n) return null;
        const children = getEdgesFrom(db, nodeId, 'RENDERS')
          .map((e) => buildTree(e.toId, currentDepth - 1))
          .filter(Boolean);
        return { ...nodeToSummary(n), children };
      }

      return {
        score: Math.round(score * 100) / 100,
        node: nodeToSummary(node),
        edges: { out: outEdges, in: inEdges },
        renderTree: buildTree(node.id, depth),
      };
    });

    // Step 3: boundary map for the given route (if provided)
    let boundaryMap = null;
    if (routeId) {
      const visited = new Set<string>();
      const boundary: Array<{ id: string; name: string; path: string; isClient: boolean; isServer: boolean }> = [];
      function traverse(nodeId: string) {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        const node = getNodeById(db, nodeId);
        if (!node) return;
        boundary.push({
          id: node.id, name: node.name, path: node.path,
          isClient: node.properties.isClient ?? false,
          isServer: node.properties.isServer ?? false,
        });
        for (const edge of getEdgesFrom(db, nodeId, 'RENDERS')) traverse(edge.toId);
        for (const edge of getEdgesFrom(db, nodeId, 'ROUTE_HANDLES')) traverse(edge.toId);
      }
      traverse(routeId);
      boundaryMap = boundary;
    }

    return ok({ candidates: enriched, boundaryMap });
  };
}

// ---------------------------------------------------------------------------
// Shared node summary
// ---------------------------------------------------------------------------

function nodeToSummary(node: GraphNode) {
  return {
    id: node.id,
    label: node.label,
    name: node.name,
    path: node.path,
    importanceScore: node.properties.importanceScore ?? 0,
    isClient: node.properties.isClient,
    isServer: node.properties.isServer,
    propNames: node.properties.propNames,
    usageCount: node.properties.usageCount,
  };
}
