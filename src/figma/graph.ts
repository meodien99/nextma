import Database from 'better-sqlite3';
import type { NormalizedFigmaFile } from './normalize.js';
import { upsertNode, upsertEdge, searchNodes } from '../db/index.js';
import { nodeId, edgeId } from '../scanner/extract.js';

// ---------------------------------------------------------------------------
// Write FigmaNode entity + FIGMA_MAPS_TO edges into graph.db
// ---------------------------------------------------------------------------

export function writeFigmaNode(
  db: Database.Database,
  opts: {
    figmaUrl: string;
    fileKey: string;
    nodeId: string;
    componentName: string;
    componentSlug: string;
    normalized: NormalizedFigmaFile;
  },
): string {
  const id = nodeId('figma', opts.componentSlug);

  upsertNode(db, {
    id,
    label: 'FigmaNode',
    name: opts.componentName,
    path: `figma/${opts.componentSlug}`,
    startLine: 0,
    endLine: 0,
    isExported: false,
    contentHash: '',
    properties: {
      figmaUrl: opts.figmaUrl,
      fileKey: opts.fileKey,
      nodeId: opts.nodeId,
      componentSlug: opts.componentSlug,
    },
  });

  // Match code artifacts by name overlap
  const words = opts.componentName
    .toLowerCase()
    .split(/[\s/\-_]+/)
    .filter((w) => w.length > 2);

  const candidates = [
    ...searchNodes(db, { label: 'Component', limit: 500 }),
    ...searchNodes(db, { label: 'Hook', limit: 200 }),
  ];

  for (const candidate of candidates) {
    const target = `${candidate.name} ${candidate.path}`.toLowerCase();
    const overlap = words.filter((w) => target.includes(w)).length;
    if (overlap === 0) continue;

    upsertEdge(db, {
      id: edgeId(id, 'FIGMA_MAPS_TO', candidate.id),
      fromId: id,
      toId: candidate.id,
      kind: 'FIGMA_MAPS_TO',
      properties: {},
    });
  }

  return id;
}
