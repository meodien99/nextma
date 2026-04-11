// ---------------------------------------------------------------------------
// Node labels
// ---------------------------------------------------------------------------

export type NodeLabel =
  | 'File'
  | 'Component'
  | 'Hook'
  | 'Utility'
  | 'Type'
  | 'Route'
  | 'Layout'
  | 'DesignToken'
  | 'FigmaNode';

// ---------------------------------------------------------------------------
// Edge kinds
// ---------------------------------------------------------------------------

export type EdgeKind =
  | 'DEFINES'        // File → Component/Hook/Utility/Type
  | 'IMPORTS'        // File → File
  | 'RENDERS'        // Component → Component (JSX child usage)
  | 'CALLS'          // Component/Hook → Hook/Utility
  | 'ROUTE_HANDLES'  // Route → Component
  | 'LAYOUT_WRAPS'   // Layout → Route/Layout
  | 'USES_TOKEN'     // Component → DesignToken
  | 'FIGMA_MAPS_TO'; // FigmaNode → Component/Hook

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export interface NodeProperties {
  // Component
  isClient?: boolean;
  isServer?: boolean;
  isPage?: boolean;
  isLayout?: boolean;
  propNames?: string[];
  isIconComponent?: boolean;
  // Route
  routePath?: string;
  routerKind?: 'app' | 'pages';
  // DesignToken
  tokenCategory?: string; // 'colors' | 'spacing' | 'fontSize' | etc.
  tokenValue?: string;    // raw tailwind value e.g. 'hsl(var(--neutral-300))'
  resolvedHex?: string;   // resolved hex color e.g. '#2D3142' (colors only)
  // DesignToken — typography (fontSize category)
  fontSize?: number;      // px
  lineHeight?: number;    // px
  fontWeight?: number;    // 400 | 500 | 700
  // FigmaNode
  figmaUrl?: string;
  fileKey?: string;
  nodeId?: string;
  componentSlug?: string;
  // Shared
  importanceScore?: number;
  usageCount?: number;
  linesOfCode?: number;
  exportedNames?: string[];
}

export interface GraphNode {
  id: string;
  label: NodeLabel;
  name: string;
  path: string;          // relative to project root
  startLine: number;
  endLine: number;
  isExported: boolean;
  contentHash: string;
  properties: NodeProperties;
}

// ---------------------------------------------------------------------------
// Edge
// ---------------------------------------------------------------------------

export interface EdgeProperties {
  importedNames?: string[];  // for IMPORTS edges
  resolvedPath?: string;     // resolved import path
}

export interface GraphEdge {
  id: string;
  fromId: string;
  toId: string;
  kind: EdgeKind;
  properties: EdgeProperties;
}

// ---------------------------------------------------------------------------
// Scanner intermediate types
// ---------------------------------------------------------------------------

export interface RawExport {
  name: string;
  kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'unknown';
  isDefault: boolean;
  startLine: number;
  endLine: number;
}

export interface RawImport {
  source: string;
  names: string[];
}

export interface RawReExport {
  source: string;   // e.g. './research/utils'
  names: string[];  // empty = export * from source
}

export interface ParsedFile {
  path: string;          // absolute
  relativePath: string;  // relative to project root
  exports: RawExport[];
  imports: RawImport[];
  reExports: RawReExport[];
  jsxUsed: string[];     // component names used as JSX children
  directive: 'use client' | 'use server' | null;
  linesOfCode: number;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Scan result
// ---------------------------------------------------------------------------

export interface ScanMeta {
  projectRoot: string;
  scannedAt: string;
  scanVersion: string;
  totalNodes: number;
  totalEdges: number;
  routerKind: 'app' | 'pages' | 'mixed' | 'unknown';
  hasTypeScript: boolean;
}
