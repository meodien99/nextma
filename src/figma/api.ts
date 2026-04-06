import * as path from 'path';
import * as fs from 'fs';

const FIGMA_API_BASE = 'https://api.figma.com/v1';

// ---------------------------------------------------------------------------
// Token loading
// ---------------------------------------------------------------------------

export function loadFigmaToken(): string {
  if (process.env['FIGMA_ACCESS_TOKEN']) return process.env['FIGMA_ACCESS_TOKEN'];

  const candidates = [
    path.join(__dirname, '..', '..', '.env'),
    path.join(process.cwd(), '.env'),
  ];

  for (const envFile of candidates) {
    if (!fs.existsSync(envFile)) continue;
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const eqIdx = trimmed.indexOf('=');
      const key = trimmed.slice(0, eqIdx).trim();
      if (key === 'FIGMA_ACCESS_TOKEN') {
        const value = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
        if (value) return value;
      }
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export interface FigmaRef {
  fileKey: string;
  nodeId: string; // colon-separated format, e.g. "21965:175234"
}

export function parseFigmaUrl(url: string): FigmaRef | null {
  try {
    const u = new URL(url);
    // Path: /design/FILE_KEY/... or /file/FILE_KEY/...
    const match = u.pathname.match(/\/(design|file)\/([^/]+)/);
    if (!match || !match[2]) return null;
    const fileKey = match[2];

    // node-id can be "21965-175234" or "21965%3A175234" (colon encoded)
    const rawNodeId = u.searchParams.get('node-id');
    if (!rawNodeId) return null;

    // Normalise to colon format for the API
    const nodeId = decodeURIComponent(rawNodeId).replace(/-/g, ':');
    return { fileKey, nodeId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Figma API calls
// ---------------------------------------------------------------------------

export interface FigmaStyleEntry {
  name: string;        // e.g. "Caption/Regular/12", "Neutral/300"
  styleType: 'TEXT' | 'FILL' | 'EFFECT' | 'GRID';
}

export interface FigmaApiNode {
  document: FigmaRawNode;
  components: Record<string, unknown>;
  styles: Record<string, FigmaStyleEntry>;  // styleId → entry
}

export interface FigmaRawNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaRawNode[];
  fills?: FigmaFill[];
  strokes?: FigmaFill[];
  style?: FigmaTextStyle;
  characters?: string;
  /** Style ID references per property: "text" | "fill" | "stroke" | "effect" → styleId */
  styles?: Record<string, string>;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  layoutMode?: 'HORIZONTAL' | 'VERTICAL' | 'NONE';
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  cornerRadius?: number;
  componentId?: string;
  [key: string]: unknown;
}

export interface FigmaFill {
  type: string;
  color?: { r: number; g: number; b: number; a: number };
  opacity?: number;
}

export interface FigmaTextStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  letterSpacing?: number;
  lineHeightPx?: number;
  textAlignHorizontal?: string;
}

export async function fetchFigmaImageBase64(token: string, ref: FigmaRef): Promise<{ base64: string; mimeType: 'image/png' } | null> {
  try {
    const url = `https://api.figma.com/v1/images/${ref.fileKey}?ids=${encodeURIComponent(ref.nodeId)}&format=png&scale=1.5`;
    const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
    if (!res.ok) return null;

    const data = await res.json() as { err: string | null; images: Record<string, string> };
    if (data.err) return null;

    // The key may use colon or encoded variants — find the first match
    const imageUrl = data.images[ref.nodeId]
      ?? Object.values(data.images)[0];
    if (!imageUrl) return null;

    // Validate URL is HTTPS and from a known Figma domain before fetching
    const parsedImageUrl = new URL(imageUrl);
    if (parsedImageUrl.protocol !== 'https:' ||
        !/(^|\.)figma\.com$/.test(parsedImageUrl.hostname)) {
      return null;
    }

    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;

    const buffer = await imgRes.arrayBuffer();
    return { base64: Buffer.from(buffer).toString('base64'), mimeType: 'image/png' };
  } catch {
    return null;
  }
}

export async function fetchFigmaNode(token: string, ref: FigmaRef): Promise<FigmaApiNode> {
  const url = `${FIGMA_API_BASE}/files/${ref.fileKey}/nodes?ids=${encodeURIComponent(ref.nodeId)}`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Figma API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { nodes: Record<string, FigmaApiNode> };
  const node = data.nodes[ref.nodeId];
  if (!node) {
    // Figma may return the key with colon replaced by different encoding
    const firstNode = Object.values(data.nodes)[0];
    if (!firstNode) throw new Error(`Node ${ref.nodeId} not found in Figma response`);
    return firstNode;
  }
  return node;
}
