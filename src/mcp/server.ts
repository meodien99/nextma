import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as path from 'path';
import { openDb } from '../db/index.js';
import {
  searchNodesTool,
  getNodeTool,
  getRelationsTool,
  getRouteTreeTool,
  getComponentTreeTool,
  getBoundaryMapTool,
  findReusableTool,
  detectChangesTool,
  figmaMatchesTool,
  reconTool,
} from './tools.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'recon',
    description: 'Pre-task recon: given a feature description, returns ranked reusable candidates with their full shape (edges, render tree) and optionally the server/client boundary map for a route. Run this FIRST before building anything new — it replaces 4 sequential tool calls with one.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural language description of the feature you are about to build' },
        routeId: { type: 'string', description: 'Route node ID to include server/client boundary map (recommended when adding hooks or client components)' },
        depth: { type: 'number', default: 2, description: 'Render tree depth for each candidate' },
      },
    },
  },
  {
    name: 'find_reusable',
    description: 'Find existing components, hooks, and utilities relevant to a natural language query. Uses relevance scoring that matches camelCase segments and dependency relationships — not just exact name matching. Call this before creating any new component, hook, or utility.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Natural language description, e.g. "display token balance solana"' },
        limit: { type: 'number', default: 15 },
      },
    },
  },
  {
    name: 'search_nodes',
    description: 'Find graph nodes by exact label, name pattern, or path pattern. Use when you know the exact name or file path. For feature-based search, prefer find_reusable.',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', enum: ['File', 'Component', 'Hook', 'Utility', 'Type', 'Route', 'Layout', 'DesignToken', 'FigmaNode'] },
        namePattern: { type: 'string', description: 'Substring match on node name' },
        pathPattern: { type: 'string', description: 'Substring match on file path' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
  {
    name: 'get_node',
    description: 'Get full details of a single node including all its edges (imports, renders, calls).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
    },
  },
  {
    name: 'get_relations',
    description: 'Get edges from/to a node, optionally filtered by edge kind (IMPORTS, RENDERS, CALLS, ROUTE_HANDLES, LAYOUT_WRAPS).',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        direction: { type: 'string', enum: ['from', 'to', 'both'], default: 'both' },
        kind: { type: 'string', description: 'Edge kind filter' },
      },
    },
  },
  {
    name: 'get_route_tree',
    description: 'Get the full Next.js App Router / Pages Router route hierarchy with layout nesting. Use to understand the app structure or find a routeId for get_boundary_map.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_component_tree',
    description: 'Get the render tree rooted at a component (follows RENDERS edges). Use to understand what a component is composed of.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
        depth: { type: 'number', default: 3 },
      },
    },
  },
  {
    name: 'get_boundary_map',
    description: 'Get the server/client component boundary map for a route — every reachable component labelled isClient or isServer. Call this before adding a hook or any client-side logic to a route component, to know if a "use client" boundary already exists or needs to be added.',
    inputSchema: {
      type: 'object',
      required: ['routeId'],
      properties: { routeId: { type: 'string' } },
    },
  },
  {
    name: 'detect_changes',
    description: 'Show when the graph was last scanned. Call this at the start of a session to verify the graph is fresh before relying on it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'figma_matches',
    description: 'Get pre-computed FIGMA_MAPS_TO matches for a Figma component slug. Only available if nextma figma-parse has been run for this component.',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: { slug: { type: 'string', description: 'The component slug used in figma-parse' } },
    },
  },
];

// ---------------------------------------------------------------------------
// Start MCP server
// ---------------------------------------------------------------------------

export async function startMcpServer(contextDir: string, _projectRoot: string): Promise<void> {
  const dbPath = path.resolve(contextDir);
  const db = openDb(dbPath);

  const server = new Server(
    { name: 'nextma', version: '2.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;

    switch (name) {
      case 'recon':             return reconTool(db)(args as { query: string; routeId?: string; depth?: number });
      case 'find_reusable':     return findReusableTool(db)(args as { query: string; limit?: number });
      case 'search_nodes':      return searchNodesTool(db)(args as { label?: string; namePattern?: string; pathPattern?: string; limit?: number });
      case 'get_node':          return getNodeTool(db)(args as { id: string });
      case 'get_relations':     return getRelationsTool(db)(args as { id: string; direction?: 'from' | 'to' | 'both'; kind?: string });
      case 'get_route_tree':    return getRouteTreeTool(db)();
      case 'get_component_tree': return getComponentTreeTool(db)(args as { id: string; depth?: number });
      case 'get_boundary_map':  return getBoundaryMapTool(db)(args as { routeId: string });
      case 'detect_changes':    return detectChangesTool(db)();
      case 'figma_matches':     return figmaMatchesTool(db)(args as { slug: string });
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
