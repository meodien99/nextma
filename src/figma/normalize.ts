import { FigmaRawNode, FigmaFill, FigmaTextStyle, FigmaStyleEntry } from './api';

// ---------------------------------------------------------------------------
// Normalized types
// ---------------------------------------------------------------------------

export interface NormalizedColor {
  hex: string;
  opacity: number;
  /** Token name derived from Figma fill style name e.g. "color-700", "neutral" */
  tokenName?: string;
}

export interface NormalizedText {
  content: string;
  /** Named Figma style e.g. "Caption/Regular/12" — primary token source */
  styleName?: string;
  /** Tailwind class derived from styleName e.g. "text-caption-regular-12" */
  tailwindClass?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
  color?: NormalizedColor;
  /** Named Figma fill style e.g. "Neutral/700" */
  colorStyleName?: string;
}

export interface NormalizedLayout {
  width?: number;
  height?: number;
  direction?: 'horizontal' | 'vertical';
  gap?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  cornerRadius?: number;
}

export interface NormalizedNode {
  id: string;
  name: string;
  type: string;
  layout?: NormalizedLayout;
  fills?: NormalizedColor[];
  text?: NormalizedText;
  /** Component name if this is an INSTANCE node */
  componentRef?: string;
  children?: NormalizedNode[];
}

export interface NormalizedFigmaFile {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  root: NormalizedNode;
  /** All unique INSTANCE node names found in the tree (component references) */
  componentRefs: string[];
  /** All TEXT nodes found in the tree */
  textNodes: NormalizedText[];
  /** All unique fill colors found across the tree (hex strings) */
  colorPalette: string[];
  /** hex → token name, derived from Figma fill style names */
  colorStyles: Record<string, string>;
  /** Detected icon references (nodes whose name/type suggests an icon) */
  iconRefs: string[];
}

// ---------------------------------------------------------------------------
// Style name → Tailwind class
// e.g. "Caption/Regular/12" → "text-caption-regular-12"
// ---------------------------------------------------------------------------

function styleNameToTailwind(styleName: string): string {
  return 'text-' + styleName
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

// ---------------------------------------------------------------------------
// Fill style name → design token name
// e.g. "Neutral/$color-700-base [night]" → "color-700"
//      "Neutral/$color-0 [night]"        → "neutral"  (color-0 = group default)
// ---------------------------------------------------------------------------

export function fillStyleNameToToken(styleName: string): string {
  const parts = styleName.split('/');
  const group = parts[0].trim().toLowerCase();
  const raw = (parts[parts.length - 1] ?? parts[0]).trim();

  // Remove $ prefix, theme suffix like " [night]" or " [day]"
  let token = raw
    .replace(/^\$/, '')
    .replace(/\s*\[.*?\]\s*$/, '')
    .trim();

  // Remove -base / -hover / -active / -disabled variant suffixes
  token = token.replace(/-(base|hover|active|disabled|focus|pressed)$/i, '');

  // Special case: color-0 means the group default (e.g. "neutral")
  if (token === 'color-0') return group;

  return token;
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function toHex(r: number, g: number, b: number): string {
  const byte = (n: number) => Math.round(n * 255).toString(16).padStart(2, '0');
  return `#${byte(r)}${byte(g)}${byte(b)}`.toUpperCase();
}

function extractFills(fills: FigmaFill[], colorStyleName?: string): NormalizedColor[] {
  const result: NormalizedColor[] = [];
  const tokenName = colorStyleName ? fillStyleNameToToken(colorStyleName) : undefined;
  for (const fill of fills) {
    if (fill.type === 'SOLID' && fill.color) {
      result.push({
        hex: toHex(fill.color.r, fill.color.g, fill.color.b),
        opacity: fill.opacity ?? fill.color.a ?? 1,
        tokenName,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Icon detection
// ---------------------------------------------------------------------------

const ICON_NAME_RE = /icon|svg|logo|arrow|chevron|check|close|menu|search|star|heart|bell/i;

function looksLikeIcon(name: string, type: string): boolean {
  return ICON_NAME_RE.test(name) || type === 'VECTOR' || type === 'BOOLEAN_OPERATION';
}

// ---------------------------------------------------------------------------
// Recursive raw-node → normalized-node (depth-limited)
// ---------------------------------------------------------------------------

function normalizeRaw(
  raw: FigmaRawNode,
  depth: number,
  styles: Record<string, FigmaStyleEntry>,
): NormalizedNode {
  const node: NormalizedNode = { id: raw.id, name: raw.name, type: raw.type };

  // Layout
  if (raw.absoluteBoundingBox || raw.layoutMode) {
    const layout: NormalizedLayout = {};
    if (raw.absoluteBoundingBox) {
      layout.width = raw.absoluteBoundingBox.width;
      layout.height = raw.absoluteBoundingBox.height;
    }
    if (raw.layoutMode === 'HORIZONTAL') layout.direction = 'horizontal';
    if (raw.layoutMode === 'VERTICAL') layout.direction = 'vertical';
    if (raw.itemSpacing) layout.gap = raw.itemSpacing;
    if (raw.paddingTop) layout.paddingTop = raw.paddingTop;
    if (raw.paddingRight) layout.paddingRight = raw.paddingRight;
    if (raw.paddingBottom) layout.paddingBottom = raw.paddingBottom;
    if (raw.paddingLeft) layout.paddingLeft = raw.paddingLeft;
    if (raw.cornerRadius) layout.cornerRadius = raw.cornerRadius;
    if (Object.keys(layout).length > 0) node.layout = layout;
  }

  // Fills — resolve color style name if available
  const fillStyleId = raw.styles?.['fill'];
  const colorStyleName = fillStyleId ? styles[fillStyleId]?.name : undefined;
  if (raw.fills && raw.fills.length > 0) {
    const fills = extractFills(raw.fills, colorStyleName);
    if (fills.length > 0) node.fills = fills;
  }

  // Text content
  if (raw.type === 'TEXT' && raw.characters) {
    const style: FigmaTextStyle = (raw.style as FigmaTextStyle) ?? {};

    // Resolve named text style from styles map
    const textStyleId = raw.styles?.['text'];
    const styleName = textStyleId ? styles[textStyleId]?.name : undefined;
    const tailwindClass = styleName ? styleNameToTailwind(styleName) : undefined;

    node.text = {
      content: raw.characters.slice(0, 200),
      styleName,
      tailwindClass,
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeightPx: style.lineHeightPx,
      letterSpacing: style.letterSpacing,
    };
    if (raw.fills) {
      const colors = extractFills(raw.fills as FigmaFill[]);
      if (colors[0]) node.text.color = colors[0];
    }
    if (colorStyleName) node.text.colorStyleName = colorStyleName;
  }

  // Component instance reference
  if (raw.type === 'INSTANCE') {
    node.componentRef = raw.name;
  }

  // Children (depth-limited to 5 levels to keep output manageable)
  if (raw.children && raw.children.length > 0 && depth < 5) {
    node.children = raw.children.map((c) => normalizeRaw(c, depth + 1, styles));
  }

  return node;
}

// ---------------------------------------------------------------------------
// Tree walkers
// ---------------------------------------------------------------------------

function walkTree(
  node: NormalizedNode,
  componentRefs: Set<string>,
  textNodes: NormalizedText[],
  colors: Set<string>,
  colorStyles: Record<string, string>,
  iconRefs: Set<string>
): void {
  if (node.componentRef) componentRefs.add(node.componentRef);
  if (node.text) textNodes.push(node.text);
  if (node.fills) {
    node.fills.forEach((f) => {
      colors.add(f.hex);
      if (f.tokenName) colorStyles[f.hex] = f.tokenName;
    });
  }
  if (looksLikeIcon(node.name, node.type)) iconRefs.add(node.name);
  node.children?.forEach((c) => walkTree(c, componentRefs, textNodes, colors, colorStyles, iconRefs));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function normalizeFigmaNode(
  raw: FigmaRawNode,
  styles: Record<string, FigmaStyleEntry> = {},
): NormalizedFigmaFile {
  const root = normalizeRaw(raw, 0, styles);

  const componentRefs = new Set<string>();
  const textNodes: NormalizedText[] = [];
  const colors = new Set<string>();
  const colorStyles: Record<string, string> = {};
  const iconRefs = new Set<string>();
  walkTree(root, componentRefs, textNodes, colors, colorStyles, iconRefs);

  return {
    nodeId: raw.id,
    nodeName: raw.name,
    nodeType: raw.type,
    root,
    componentRefs: Array.from(componentRefs),
    textNodes,
    colorPalette: Array.from(colors),
    colorStyles,
    iconRefs: Array.from(iconRefs),
  };
}
