import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Compute and store importanceScore for all Component/Hook/Utility nodes
// ---------------------------------------------------------------------------

export function computeImportanceScores(db: Database.Database): void {
  const rows = db.prepare(
    `SELECT id, label, path, properties FROM nodes WHERE label IN ('Component', 'Hook', 'Utility', 'Route', 'Layout')`
  ).all() as Array<{ id: string; label: string; path: string; properties: string }>;

  // Count inbound IMPORTS + RENDERS + CALLS edges per node
  const usageCount = new Map<string, number>();
  const edgeRows = db.prepare(
    `SELECT to_id FROM edges WHERE kind IN ('IMPORTS', 'RENDERS', 'CALLS')`
  ).all() as Array<{ to_id: string }>;

  for (const { to_id } of edgeRows) {
    usageCount.set(to_id, (usageCount.get(to_id) ?? 0) + 1);
  }

  // Check which nodes are used by routes (proximity bonus)
  const routeAdjacentIds = new Set<string>();
  const routeEdges = db.prepare(
    `SELECT to_id FROM edges WHERE kind = 'ROUTE_HANDLES'`
  ).all() as Array<{ to_id: string }>;
  for (const { to_id } of routeEdges) routeAdjacentIds.add(to_id);

  for (const row of rows) {
    const props = JSON.parse(row.properties);
    const usage = usageCount.get(row.id) ?? 0;

    // Folder scope signal
    const isGlobal = /^src\/(components|hooks|utils|lib|services)\//.test(row.path) ||
      /^(components|hooks|utils|lib)\//.test(row.path);
    const isFeature = !isGlobal && row.path.includes('/');

    // Score formula (0–1)
    const usageSignal = Math.min(usage / 20, 0.5);           // up to 0.5
    const scopeSignal = isGlobal ? 0.3 : isFeature ? 0.15 : 0.05;
    const routeSignal = routeAdjacentIds.has(row.id) ? 0.2 : 0;

    const score = Math.min(1, usageSignal + scopeSignal + routeSignal);

    if (props.importanceScore !== score || props.usageCount !== usage) {
      props.importanceScore = Math.round(score * 100) / 100;
      props.usageCount = usage;
      db.prepare(`UPDATE nodes SET properties = ? WHERE id = ?`)
        .run(JSON.stringify(props), row.id);
    }
  }
}
