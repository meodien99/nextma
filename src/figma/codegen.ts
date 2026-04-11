import * as path from 'path';
import type { NormalizedFigmaFile } from './normalize.js';
import { findNearestToken } from './colors.js';
import type { TokenEntry } from './colors.js';

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Root figma/codegen-guide.md — generated once, user-editable
// ---------------------------------------------------------------------------

export function renderRootCodegenGuide(): string {
  return [
    '# Project Codegen Conventions',
    '',
    '> Generated once by `nextma figma-parse`. Edit this to define project-wide conventions.',
    '> All per-component codegen guides reference this file.',
    '',
    '---',
    '',
    '## Naming Conventions',
    '',
    '<!-- e.g. PascalCase for components, camelCase for hooks (useXxx), kebab-case for file names -->',
    '',
    '## Folder Structure',
    '',
    '<!-- e.g. components → src/components/<domain>/, hooks → src/hooks/, types → src/types/ -->',
    '',
    '## Styling Rules',
    '',
    '<!-- e.g. Always use Tailwind, never inline styles, use cn() for conditional classes -->',
    '',
    '## Component Patterns',
    '',
    '<!-- e.g. Always use <Button> from src/components/ui/button.tsx — never a raw <button> -->',
    '',
    '## State & Data Fetching',
    '',
    '<!-- e.g. API calls only inside hooks, never directly in components -->',
    '',
    '## Anti-patterns',
    '',
    '<!-- Project-specific things the LLM must never do -->',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// design-intent.md
// ---------------------------------------------------------------------------

function buildFontSizeMap(fontSize: Record<string, unknown>): Map<string, string> {
  const map = new Map<string, string>();
  const w = (n: string) => /bold/i.test(n) ? 700 : /medium/i.test(n) ? 500 : 400;
  for (const [name, val] of Object.entries(fontSize)) {
    const s = Array.isArray(val) ? val[0] : typeof val === 'string' ? val : null;
    if (!s) continue;
    const px = parseFloat(s as string);
    if (!isNaN(px)) map.set(`${px}+${w(name)}`, name);
  }
  return map;
}

function resolveColorToken(
  hex: string,
  colorStyles: Record<string, string>,
  tokenColorEntries?: TokenEntry[],
): string | null {
  // 1. Exact match from Figma style name (most reliable)
  if (colorStyles[hex]) return colorStyles[hex];
  // 2. Approximate RGB match from design token entries (fallback)
  return tokenColorEntries ? findNearestToken(hex, tokenColorEntries) : null;
}

export function renderDesignIntent(
  normalized: NormalizedFigmaFile,
  tokenColorEntries?: TokenEntry[],
  designTokens?: Record<string, unknown>,
): string {
  const { nodeName, nodeId, nodeType, root, componentRefs, textNodes, colorPalette, colorStyles, iconRefs } = normalized;
  const lines: string[] = [`# Design Intent: ${nodeName}`, '', `**Node ID:** \`${nodeId}\``, `**Figma Type:** ${nodeType}`];

  if (root.layout?.width && root.layout?.height)
    lines.push(`**Size:** ${Math.round(root.layout.width)} × ${Math.round(root.layout.height)}`);
  lines.push('');

  if (root.layout && Object.keys(root.layout).length > 0) {
    lines.push('## Layout', '');
    const l = root.layout;
    if (l.direction) lines.push(`- Direction: ${l.direction === 'vertical' ? 'Vertical' : 'Horizontal'}`);
    if (l.gap) lines.push(`- Gap: ${l.gap}px`);
    if ([l.paddingTop, l.paddingRight, l.paddingBottom, l.paddingLeft].some(Boolean))
      lines.push(`- Padding: ${l.paddingTop ?? 0}px ${l.paddingRight ?? 0}px ${l.paddingBottom ?? 0}px ${l.paddingLeft ?? 0}px`);
    if (l.cornerRadius) lines.push(`- Border radius: ${l.cornerRadius}px`);
    lines.push('');
  }

  if (colorPalette.length > 0) {
    lines.push('## Colors', '');
    colorPalette.slice(0, 12).forEach((hex) => {
      const token = resolveColorToken(hex, colorStyles, tokenColorEntries);
      lines.push(token ? `- \`${hex}\` → \`${token}\`` : `- \`${hex}\``);
    });
    lines.push('');
  }

  const textWithFont = textNodes.filter((t) => t.styleName || t.fontFamily || t.fontSize);
  if (textWithFont.length > 0) {
    lines.push('## Typography', '');
    const tokens = designTokens as Record<string, unknown> | undefined;
    const fsMap = tokens?.fontSize ? buildFontSizeMap(tokens.fontSize as Record<string, unknown>) : undefined;
    const seen = new Set<string>();
    for (const t of textWithFont.slice(0, 8)) {
      const key = t.styleName ?? `${t.fontFamily}-${t.fontSize}-${t.fontWeight}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (t.styleName && t.tailwindClass) {
        // Primary: named style → direct tailwind class
        lines.push(`- \`${t.styleName}\` → \`${t.tailwindClass}\` — "${t.content.slice(0, 40)}${t.content.length > 40 ? '…' : ''}"`);
      } else {
        // Fallback: raw numbers → lookup table match
        const parts = [t.fontFamily, t.fontSize ? `${t.fontSize}px` : undefined, t.fontWeight ? `weight ${t.fontWeight}` : undefined].filter(Boolean);
        const tm = t.fontSize && t.fontWeight && fsMap ? fsMap.get(`${t.fontSize}+${t.fontWeight}`) : undefined;
        lines.push(`- ${parts.join(', ')}${tm ? ` → \`text-${tm}\`` : ' → *(no token match)*'} — "${t.content.slice(0, 40)}${t.content.length > 40 ? '…' : ''}"`);
      }
    }
    lines.push('');
  }

  if (root.children && root.children.length > 0) {
    lines.push('## Sections', '');
    root.children.slice(0, 12).forEach((c, i) =>
      lines.push(`${i + 1}. **${c.name}** (${c.type}${c.children?.length ? `, ${c.children.length} children` : ''})`));
    lines.push('');
  }

  if (componentRefs.length > 0) { lines.push('## Component References', ''); componentRefs.forEach((r) => lines.push(`- \`${r}\` (INSTANCE)`)); lines.push(''); }
  if (iconRefs.length > 0) { lines.push('## Icon References', ''); iconRefs.forEach((r) => lines.push(`- \`${r}\``)); lines.push(''); }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Per-component codegen-guide.md
// ---------------------------------------------------------------------------

export interface CodegenGuideOptions {
  componentName: string;
  componentSlug: string;
  figmaUrl: string;
  normalized: NormalizedFigmaFile;
  tokenColorEntries?: TokenEntry[];
  routerKind?: string;
  hasTypeScript?: boolean;
}

export function renderCodegenGuide(opts: CodegenGuideOptions): string {
  const { componentName, componentSlug, figmaUrl, normalized, tokenColorEntries } = opts;

  const lines = [
    `# Codegen Guide: ${componentName}`,
    '',
    '> Open Claude Code and run: *"Read prepare.md and follow the steps"*',
    '',
    `**Figma source:** ${figmaUrl}`,
    `**Node:** ${normalized.nodeName} (\`${normalized.nodeId}\`)`,
    '',
    '---',
    '',
    '## Role',
    '',
    'Repo-aware code generator for a Next.js project.',
    'Read `../codegen-guide.md` first for project-wide conventions.',
    '',
    '---',
    '',
    '## Required reading (in order)',
    '',
    '1. **`../codegen-guide.md`** — project conventions',
    '2. **`preview.png`** — visual overview',
    '3. **`figma-node.json`** — exact measurements (dimensions, padding, gap, fills, border radius, hierarchy)',
    '4. **`design-intent.md`** — processed summary',
    '5. Any additional images referenced in `design-intent.md`',
    '',
    '> Pixel values MUST come from `figma-node.json`. The image alone is not sufficient.',
    '',
    '---',
    '',
    '## Project Snapshot',
    '',
    `- **Framework:** Next.js (${opts.routerKind ?? 'unknown'})`,
    `- **Language:** ${opts.hasTypeScript ? 'TypeScript' : 'JavaScript'}`,
    '',
    '---',
    '',
    '## Graph Queries',
    '',
    '```',
    `find_reusable("${componentName}")`,
    `figma_matches("${componentSlug}")`,
    `search_nodes({ label: "Component", namePattern: "..." })`,
    `get_component_tree(nodeId)`,
    '```',
    '',
    '### ⚠️ Caveats',
    '',
    '<!-- component name, missing prop, what was done instead -->',
    '',
    '---',
    '',
  ];

  if (normalized.colorPalette.length > 0 && (Object.keys(normalized.colorStyles).length > 0 || tokenColorEntries)) {
    lines.push('## Color Mapping', '', '> Match → use token. No match → raw hex. Never invent a class.', '');
    for (const hex of normalized.colorPalette.slice(0, 8)) {
      const t = resolveColorToken(hex, normalized.colorStyles, tokenColorEntries);
      lines.push(t ? `- \`${hex}\` → \`${t}\`` : `- \`${hex}\` → *(no match — use hex directly)*`);
    }
    lines.push('', '---', '');
  }

  if (normalized.iconRefs.length > 0) {
    lines.push('## Icons', '');
    normalized.iconRefs.forEach((r) => lines.push(`- ${r}`));
    lines.push('', '> `search_nodes({ label: "Component", namePattern: "Icon" })`');
    lines.push('> Match → import. No match → inline SVG + `<!-- TODO: extract to icon component -->`', '', '---', '');
  }

  lines.push(
    '## Utilities',
    '',
    '1. Match in graph → import',
    '2. Used in 1 file → write inline',
    '3. Used in 2+ files → new util file in same module',
    '',
    '---',
    '',
    '## User Intent',
    '',
    '> **See `../codegen-guide.md` for conventions — do not restate them here.**',
    '',
    '- **Purpose:** <!-- what this component does and where it fits -->',
    '- **Constraints:** <!-- which existing graph components must be used -->',
    '- **Out of scope:** <!-- separate concerns visible in the design -->',
    '',
    '- **Component structure:**',
    '  <!--',
    '  [C] ComponentName(props: PropsType)       ← reuse: src/components/foo.tsx',
    '  [H]   useHookName() → { data, loading }   ← new',
    '  [C]   ChildComponent(props)               ← verify: src/components/bar.tsx',
    '  [T] NewType { field: Type }',
    '  -->',
    '',
    '---',
    '',
    '## Anti-patterns',
    '',
    '- Do not create a component when a matching one exists in the graph',
    '- Do not invent Tailwind classes — use raw hex if no token match',
    '- Do not create an icon component — inline SVG with TODO comment if no match',
    '- Do not write a utility in a new file when used only once',
    '- Do not silently work around missing props — surface in ⚠️ Caveats',
    '',
    '---',
    '',
    '## Output Format',
    '',
    '1. **Plan** — files to create/modify, components to reuse/create',
    '2. **⚠️ Caveats** — prop mismatches, missing icons',
    '3. **Code** — implementation, file by file',
    '4. **Follow-up** — anything the user must do manually',
  );

  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// prepare.md — new component
// ---------------------------------------------------------------------------

export function renderPrepareGuide(
  componentName: string,
  componentSlug: string,
  figmaDir: string,
  contextDir: string,
): string {
  const relDir = path.relative(contextDir, figmaDir) || figmaDir;
  const rootGuide = path.join(contextDir, 'figma', 'codegen-guide.md');

  return [
    `# Prepare: ${componentName}`,
    '',
    'Work through each step, then **stop and wait for confirmation** before writing any code.',
    '',
    '## Step 1 — Read project conventions',
    `Read \`${rootGuide}\``,
    '',
    '## Step 2 — Study the design',
    `1. \`${path.join(relDir, 'preview.png')}\``,
    `2. \`${path.join(relDir, 'figma-node.json')}\` — exact measurements`,
    `3. \`${path.join(relDir, 'design-intent.md')}\``,
    '',
    '## Step 3 — Query the graph',
    '```',
    `find_reusable("${componentName}")`,
    `figma_matches("${componentSlug}")`,
    '```',
    'Read source files of top candidates.',
    '',
    '## Step 4 — Fill in codegen-guide.md',
    `Edit \`${path.join(relDir, 'codegen-guide.md')}\` — fill in User Intent and Component Structure.`,
    '',
    '## Step 5 — Present and wait',
    'Show the updated guide. **Do not generate code until the user confirms.**',
    '',
    '## Step 6 — Generate',
    'After confirmation, follow the Output Format in codegen-guide.md.',
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// update-guide.md — updating an existing component
// ---------------------------------------------------------------------------

export function renderUpdateGuide(
  componentName: string,
  componentSlug: string,
  figmaDir: string,
  contextDir: string,
  existingFilePath?: string,
): string {
  const relDir = path.relative(contextDir, figmaDir) || figmaDir;
  const rootGuide = path.join(contextDir, 'figma', 'codegen-guide.md');
  const sourceHint = existingFilePath
    ? `Read the existing source file: \`${existingFilePath}\``
    : `Run \`search_nodes({ label: "Component", namePattern: "${componentName}" })\` to find the existing file, then read it.`;

  return [
    `# Update: ${componentName}`,
    '',
    'This is an **update** to an existing component. Read the existing source before making any changes.',
    '',
    'Work through each step, then **stop and wait for confirmation** before writing any code.',
    '',
    '## Step 1 — Read project conventions',
    `Read \`${rootGuide}\``,
    '',
    '## Step 2 — Read the existing component',
    sourceHint,
    'Note the current props, structure, and styling approach.',
    '',
    '## Step 3 — Study the updated design',
    `1. \`${path.join(relDir, 'preview.png')}\` — new design`,
    `2. \`${path.join(relDir, 'figma-node.json')}\` — exact measurements`,
    `3. \`${path.join(relDir, 'design-intent.md')}\` — processed summary`,
    '',
    '## Step 4 — Identify the diff',
    'List what changed between the current implementation and the new design:',
    '- Layout / spacing changes',
    '- Color / style changes',
    '- New or removed elements',
    '- Props that need to change',
    '',
    '## Step 5 — Query the graph for dependencies',
    '```',
    `get_relations("${componentSlug}", { direction: "to", kind: "RENDERS" })`,
    `figma_matches("${componentSlug}")`,
    '```',
    'Check what renders this component — breaking prop changes affect callers.',
    '',
    '## Step 6 — Present the diff and wait',
    'Show: what you will change, what stays the same, any breaking prop changes.',
    '**Do not write code until the user confirms.**',
    '',
    '## Step 7 — Apply changes',
    'Edit the existing file. Follow the Output Format in codegen-guide.md.',
    'If props changed, update call sites identified in Step 5.',
  ].join('\n') + '\n';
}
