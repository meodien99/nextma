import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { GraphNode, GraphEdge, ScanMeta } from '../types/index.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Raw DB row types
// ---------------------------------------------------------------------------

interface NodeRow {
  id: string; label: string; name: string; path: string;
  start_line: number; end_line: number; is_exported: number;
  content_hash: string; properties: string;
}

interface EdgeRow {
  id: string; from_id: string; to_id: string; kind: string; properties: string;
}

interface HashRow { content_hash: string; }
interface ValueRow { value: string; }
interface PathRow { path: string; }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL,
  start_line    INTEGER NOT NULL DEFAULT 0,
  end_line      INTEGER NOT NULL DEFAULT 0,
  is_exported   INTEGER NOT NULL DEFAULT 0,
  content_hash  TEXT NOT NULL DEFAULT '',
  properties    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS edges (
  id          TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL,
  to_id       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  properties  TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS files (
  path          TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  last_scanned  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_label ON nodes(label);
CREATE INDEX IF NOT EXISTS idx_nodes_path  ON nodes(path);
CREATE INDEX IF NOT EXISTS idx_edges_from  ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to    ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind  ON edges(kind);
`;

// ---------------------------------------------------------------------------
// Open / init
// ---------------------------------------------------------------------------

export function openDb(outputDir: string): Database.Database {
  fs.mkdirSync(outputDir, { recursive: true });
  const dbPath = path.join(outputDir, 'graph.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

export function upsertNode(db: Database.Database, node: GraphNode): void {
  db.prepare(`
    INSERT INTO nodes (id, label, name, path, start_line, end_line, is_exported, content_hash, properties)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      label        = excluded.label,
      name         = excluded.name,
      path         = excluded.path,
      start_line   = excluded.start_line,
      end_line     = excluded.end_line,
      is_exported  = excluded.is_exported,
      content_hash = excluded.content_hash,
      properties   = excluded.properties
  `).run(
    node.id,
    node.label,
    node.name,
    node.path,
    node.startLine,
    node.endLine,
    node.isExported ? 1 : 0,
    node.contentHash,
    JSON.stringify(node.properties),
  );
}

export function deleteNodesByPath(db: Database.Database, relativePath: string): void {
  const rows = db.prepare(`SELECT id FROM nodes WHERE path = ?`).all(relativePath) as { id: string }[];
  for (const { id } of rows) {
    db.prepare(`DELETE FROM edges WHERE from_id = ? OR to_id = ?`).run(id, id);
  }
  db.prepare(`DELETE FROM nodes WHERE path = ?`).run(relativePath);
}

export function getNodeByPath(db: Database.Database, relativePath: string): GraphNode | null {
  const row = db.prepare(`SELECT * FROM nodes WHERE path = ? LIMIT 1`).get(relativePath) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

export function getNodeById(db: Database.Database, id: string): GraphNode | null {
  const row = db.prepare(`SELECT * FROM nodes WHERE id = ? LIMIT 1`).get(id) as NodeRow | undefined;
  return row ? rowToNode(row) : null;
}

export function searchNodes(
  db: Database.Database,
  opts: { label?: string; namePattern?: string; pathPattern?: string; limit?: number }
): GraphNode[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (opts.label) { conditions.push('label = ?'); params.push(opts.label); }
  if (opts.namePattern) { conditions.push('name LIKE ?'); params.push(`%${opts.namePattern}%`); }
  if (opts.pathPattern) { conditions.push('path LIKE ?'); params.push(`%${opts.pathPattern}%`); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = opts.limit ?? 50;
  const rows = db.prepare(`SELECT * FROM nodes ${where} LIMIT ?`).all(...params, limit) as NodeRow[];
  return rows.map(rowToNode);
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    label: row.label,
    name: row.name,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    isExported: row.is_exported === 1,
    contentHash: row.content_hash,
    properties: JSON.parse(row.properties),
  };
}

// ---------------------------------------------------------------------------
// Edge helpers
// ---------------------------------------------------------------------------

export function upsertEdge(db: Database.Database, edge: GraphEdge): void {
  db.prepare(`
    INSERT OR IGNORE INTO edges (id, from_id, to_id, kind, properties)
    VALUES (?, ?, ?, ?, ?)
  `).run(edge.id, edge.fromId, edge.toId, edge.kind, JSON.stringify(edge.properties));
}

export function deleteEdgesByNode(db: Database.Database, nodeId: string): void {
  db.prepare(`DELETE FROM edges WHERE from_id = ? OR to_id = ?`).run(nodeId, nodeId);
}

export function getEdgesFrom(db: Database.Database, fromId: string, kind?: string): GraphEdge[] {
  const rows = (kind
    ? db.prepare(`SELECT * FROM edges WHERE from_id = ? AND kind = ?`).all(fromId, kind)
    : db.prepare(`SELECT * FROM edges WHERE from_id = ?`).all(fromId)) as EdgeRow[];
  return rows.map(rowToEdge);
}

export function getEdgesTo(db: Database.Database, toId: string, kind?: string): GraphEdge[] {
  const rows = (kind
    ? db.prepare(`SELECT * FROM edges WHERE to_id = ? AND kind = ?`).all(toId, kind)
    : db.prepare(`SELECT * FROM edges WHERE to_id = ?`).all(toId)) as EdgeRow[];
  return rows.map(rowToEdge);
}

export function getAllEdges(db: Database.Database): GraphEdge[] {
  const rows = db.prepare(`SELECT * FROM edges`).all() as EdgeRow[];
  return rows.map(rowToEdge);
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    kind: row.kind,
    properties: JSON.parse(row.properties),
  };
}

// ---------------------------------------------------------------------------
// File hash helpers (incremental scan)
// ---------------------------------------------------------------------------

export function upsertFileHash(db: Database.Database, relativePath: string, hash: string): void {
  db.prepare(`
    INSERT INTO files (path, content_hash, last_scanned)
    VALUES (?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      content_hash = excluded.content_hash,
      last_scanned = excluded.last_scanned
  `).run(relativePath, hash, new Date().toISOString());
}

export function getFileHash(db: Database.Database, relativePath: string): string | null {
  const row = db.prepare(`SELECT content_hash FROM files WHERE path = ?`).get(relativePath) as HashRow | undefined;
  return row ? row.content_hash : null;
}

export function deleteFileRecord(db: Database.Database, relativePath: string): void {
  db.prepare(`DELETE FROM files WHERE path = ?`).run(relativePath);
}

export function getAllFilePaths(db: Database.Database): string[] {
  const rows = db.prepare(`SELECT path FROM files`).all() as PathRow[];
  return rows.map((r) => r.path);
}

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as ValueRow | undefined;
  return row ? row.value : null;
}

export function saveScanMeta(db: Database.Database, meta: ScanMeta): void {
  setMeta(db, 'scanMeta', JSON.stringify(meta));
}

export function getScanMeta(db: Database.Database): ScanMeta | null {
  const raw = getMeta(db, 'scanMeta');
  return raw ? JSON.parse(raw) : null;
}

// ---------------------------------------------------------------------------
// Graph export (for visualize)
// ---------------------------------------------------------------------------

export interface GraphData {
  nodes: Array<{ id: string; name: string; label: string; path: string; val: number; color: string }>;
  links: Array<{ source: string; target: string; kind: string }>;
}

const LABEL_COLORS: Record<string, string> = {
  Component:   '#60a5fa', // blue
  Hook:        '#34d399', // green
  Utility:     '#a78bfa', // purple
  Type:        '#94a3b8', // slate
  Route:       '#fb923c', // orange
  Layout:      '#c084fc', // violet
  DesignToken: '#fbbf24', // yellow
  FigmaNode:   '#f472b6', // pink
};

export function exportGraphData(db: Database.Database): GraphData {
  const nodeRows = db.prepare(`SELECT * FROM nodes`).all() as NodeRow[];
  const edgeRows = db.prepare(`SELECT * FROM edges`).all() as EdgeRow[];

  const nodes = nodeRows.map((row) => {
    const props = JSON.parse(row.properties) as { importanceScore?: number };
    return {
      id: row.id,
      name: row.name,
      label: row.label,
      path: row.path,
      val: Math.max(1, Math.round((props.importanceScore ?? 0.1) * 10)),
      color: LABEL_COLORS[row.label as string] ?? '#94a3b8',
    };
  });

  const links = edgeRows.map((row) => ({
    source: row.from_id,
    target: row.to_id,
    kind: row.kind,
  }));

  return { nodes, links };
}
