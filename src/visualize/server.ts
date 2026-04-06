import express from 'express';
import * as http from 'http';
import { openDb, exportGraphData, getScanMeta, getNodeById, getEdgesFrom, getEdgesTo } from '../db/index.js';

// ---------------------------------------------------------------------------
// HTML shell — uses react-force-graph-2d via CDN (no build step)
// ---------------------------------------------------------------------------

function buildHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>nextma — graph</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0f1117; color: #e2e8f0; font-family: system-ui, sans-serif; display: flex; height: 100vh; overflow: hidden; }
    #graph { flex: 1; }
    #panel {
      width: 320px; min-width: 320px; background: #1a1d27; border-left: 1px solid #2d3148;
      padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px;
    }
    #panel h2 { font-size: 13px; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
    #node-name { font-size: 16px; font-weight: 700; color: #f1f5f9; }
    #node-label { font-size: 12px; padding: 2px 8px; border-radius: 9999px; display: inline-block; margin-top: 4px; }
    #node-path { font-size: 11px; color: #64748b; margin-top: 4px; word-break: break-all; }
    #node-props { font-size: 12px; color: #94a3b8; }
    #node-edges { font-size: 12px; }
    .edge-item { padding: 4px 0; border-bottom: 1px solid #2d3148; color: #cbd5e1; }
    .edge-kind { font-size: 10px; color: #64748b; }
    #filters { display: flex; flex-wrap: wrap; gap: 6px; }
    .filter-btn {
      font-size: 11px; padding: 3px 10px; border-radius: 9999px; border: none; cursor: pointer;
      background: #2d3148; color: #cbd5e1;
    }
    .filter-btn.active { opacity: 1; }
    .filter-btn.inactive { opacity: 0.35; }
    #search { width: 100%; background: #2d3148; border: 1px solid #3d4268; border-radius: 6px; padding: 6px 10px; color: #e2e8f0; font-size: 13px; outline: none; }
    #search:focus { border-color: #6366f1; }
    #stats { font-size: 11px; color: #64748b; }
    .empty { color: #4a5568; font-size: 12px; font-style: italic; }
    .node-link { color: #818cf8; cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
    .node-link:hover { color: #a5b4fc; }
  </style>
</head>
<body>
  <div id="graph"></div>
  <div id="panel">
    <div>
      <h2>nextma</h2>
      <div id="stats">Loading…</div>
    </div>
    <input id="search" type="text" placeholder="Search nodes…" />
    <div>
      <h2 style="margin-bottom:8px">Filter by type</h2>
      <div id="filters"></div>
    </div>
    <div id="node-detail">
      <p class="empty">Click a node to inspect it</p>
    </div>
  </div>

  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/react-force-graph-2d"></script>
  <script>
    const LABEL_COLORS = {
      File: '#334155',
      Component: '#60a5fa',
      Hook: '#34d399',
      Utility: '#a78bfa',
      Type: '#94a3b8',
      Route: '#fb923c',
      Layout: '#c084fc',
      DesignToken: '#fbbf24',
      FigmaNode: '#f472b6',
    };

    let allNodes = [], allLinks = [], activeLabels = new Set(), searchText = '';

    async function loadGraph() {
      const [graphRes, metaRes] = await Promise.all([
        fetch('/api/graph'),
        fetch('/api/meta'),
      ]);
      const { nodes, links } = await graphRes.json();
      const meta = await metaRes.json();

      allNodes = nodes;
      allLinks = links;

      document.getElementById('stats').textContent =
        \`\${nodes.length} nodes · \${links.length} edges · scanned \${meta.scannedAt ? new Date(meta.scannedAt).toLocaleString() : 'unknown'}\`;

      // Build label filters
      const labels = [...new Set(nodes.map(n => n.label))].sort();
      labels.forEach(l => activeLabels.add(l));

      const filters = document.getElementById('filters');
      labels.forEach(label => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn active';
        btn.textContent = label;
        btn.style.background = LABEL_COLORS[label] + '33';
        btn.style.color = LABEL_COLORS[label];
        btn.onclick = () => {
          if (activeLabels.has(label)) { activeLabels.delete(label); btn.className = 'filter-btn inactive'; }
          else { activeLabels.add(label); btn.className = 'filter-btn active'; }
          renderGraph();
        };
        filters.appendChild(btn);
      });

      renderGraph();
    }

    let graphInstance = null;
    let graphRef = React.createRef();
    let selectedNodeId = null;

    function getFilteredData() {
      const q = searchText.toLowerCase();
      const nodes = allNodes.filter(n =>
        activeLabels.has(n.label) &&
        (!q || n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q))
      );
      const nodeIds = new Set(nodes.map(n => n.id));
      const links = allLinks.filter(l => nodeIds.has(l.source?.id ?? l.source) && nodeIds.has(l.target?.id ?? l.target));
      return { nodes, links };
    }

    function renderGraph() {
      const data = getFilteredData();
      const container = document.getElementById('graph');

      const props = {
        ref: graphRef,
        graphData: data,
        width: container.offsetWidth,
        height: container.offsetHeight,
        nodeLabel: n => \`\${n.label}: \${n.name}\`,
        nodeVal: n => n.val || 1,
        linkColor: () => '#3d4268',
        linkWidth: 1,
        linkDirectionalArrowLength: 4,
        linkDirectionalArrowRelPos: 1,
        linkDirectionalArrowColor: () => '#6366f1',
        backgroundColor: '#0f1117',
        onNodeClick: node => selectNodeById(node.id),
        nodeCanvasObject: (node, ctx, globalScale) => {
          const isSelected = node.id === selectedNodeId;
          const r = Math.sqrt(node.val || 1) * (isSelected ? 4 : 3);
          // Glow for selected
          if (isSelected) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, r + 4, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.fill();
          }
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = isSelected ? '#ffffff' : (LABEL_COLORS[node.label] || '#94a3b8');
          ctx.fill();
          if (globalScale > 1.5 || isSelected) {
            ctx.font = \`\${isSelected ? Math.min(14 / globalScale, 8) : Math.min(12 / globalScale, 6)}px sans-serif\`;
            ctx.fillStyle = isSelected ? '#ffffff' : '#e2e8f0';
            ctx.textAlign = 'center';
            ctx.fillText(node.name, node.x, node.y + r + 4);
          }
        },
        nodeCanvasObjectMode: () => 'replace',
      };

      if (!graphInstance) {
        graphInstance = ReactDOM.createRoot(container);
      }
      graphInstance.render(React.createElement(ForceGraph2D, props));
    }

    async function selectNodeById(id) {
      selectedNodeId = id;
      renderGraph();

      // Center graph on the node if it's in the current filtered set
      const { nodes } = getFilteredData();
      const graphNode = nodes.find(n => n.id === id);
      if (graphNode && graphRef.current) {
        setTimeout(() => {
          graphRef.current.centerAt(graphNode.x, graphNode.y, 600);
          graphRef.current.zoom(6, 600);
        }, 50);
      }

      // Show panel
      const res = await fetch(\`/api/node/\${id}\`);
      if (!res.ok) return;
      const { node: n, outEdges, inEdges } = await res.json();
      renderNodePanel(n, outEdges, inEdges);
    }

    function edgeLink(id, label, arrow) {
      return \`<span class="node-link" onclick="selectNodeById('\${id}')">\${arrow} \${label || id}</span>\`;
    }

    function renderNodePanel(n, outEdges, inEdges) {
      const color = LABEL_COLORS[n.label] || '#94a3b8';
      document.getElementById('node-detail').innerHTML = \`
        <div>
          <div id="node-name">\${n.name}</div>
          <span id="node-label" style="background:\${color}22;color:\${color}">\${n.label}</span>
          <div id="node-path">\${n.path}</div>
        </div>
        <div id="node-props">
          \${n.properties.importanceScore != null ? \`<div>Importance: <b>\${n.properties.importanceScore}</b></div>\` : ''}
          \${n.properties.isClient ? '<div>🔵 Client component</div>' : ''}
          \${n.properties.isServer ? '<div>🟢 Server component</div>' : ''}
          \${n.properties.routePath ? \`<div>Route: <b>\${n.properties.routePath}</b></div>\` : ''}
          \${n.properties.propNames?.length ? \`<div>Props: \${n.properties.propNames.join(', ')}</div>\` : ''}
        </div>
        <div id="node-edges">
          <h2 style="margin-bottom:6px">Out edges (\${outEdges.length})</h2>
          \${outEdges.slice(0, 15).map(e => {
            const target = allNodes.find(n => n.id === e.toId);
            return \`<div class="edge-item"><span class="edge-kind">\${e.kind}</span> \${edgeLink(e.toId, target?.name, '→')}</div>\`;
          }).join('')}
          \${outEdges.length > 15 ? \`<div class="empty">+\${outEdges.length - 15} more</div>\` : ''}
          <h2 style="margin-top:10px;margin-bottom:6px">In edges (\${inEdges.length})</h2>
          \${inEdges.slice(0, 15).map(e => {
            const source = allNodes.find(n => n.id === e.fromId);
            return \`<div class="edge-item"><span class="edge-kind">\${e.kind}</span> \${edgeLink(e.fromId, source?.name, '←')}</div>\`;
          }).join('')}
          \${inEdges.length > 15 ? \`<div class="empty">+\${inEdges.length - 15} more</div>\` : ''}
        </div>
      \`;
    }

    document.getElementById('search').addEventListener('input', (e) => {
      searchText = e.target.value;
      renderGraph();
      if (searchText) {
        setTimeout(() => graphRef.current?.zoomToFit(400, 40), 300);
      }
    });

    window.addEventListener('resize', () => { if (graphInstance) renderGraph(); });

    loadGraph();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Start visualize server
// ---------------------------------------------------------------------------

export function startVisualizeServer(contextDir: string, port = 4321): http.Server {
  const db = openDb(contextDir);
  const app = express();

  app.get('/api/graph', (_req, res) => {
    try {
      res.json(exportGraphData(db));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/meta', (_req, res) => {
    try {
      res.json(getScanMeta(db) ?? {});
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/api/node/:id', (req, res) => {
    if (!/^[a-zA-Z0-9_\-./]+$/.test(req.params.id)) {
      res.status(400).json({ error: 'Invalid node ID' });
      return;
    }
    try {
      const node = getNodeById(db, req.params.id);
      if (!node) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({
        node,
        outEdges: getEdgesFrom(db, req.params.id),
        inEdges: getEdgesTo(db, req.params.id),
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('*', (_req, res) => {
    res.send(buildHtml());
  });

  return app.listen(port);
}
