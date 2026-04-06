import * as fs from 'fs';
import type { ParsedFile, RawExport, RawImport, RawReExport } from '../types/index.js';

// ---------------------------------------------------------------------------
// tree-sitter setup (lazy init to avoid startup cost)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Parser = require('tree-sitter');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { typescript: tsLang, tsx: tsxLang } = require('tree-sitter-typescript');

let tsParser: typeof Parser | null = null;
let tsxParser: typeof Parser | null = null;

function getTsParser() {
  if (!tsParser) { tsParser = new Parser(); tsParser.setLanguage(tsLang); }
  return tsParser;
}

function getTsxParser() {
  if (!tsxParser) { tsxParser = new Parser(); tsxParser.setLanguage(tsxLang); }
  return tsxParser;
}

// ---------------------------------------------------------------------------
// AST walker
// ---------------------------------------------------------------------------

type SyntaxNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  childForFieldName: (name: string) => SyntaxNode | null;
  firstNamedChild: SyntaxNode | null;
};

function walk(node: SyntaxNode, fn: (n: SyntaxNode) => void): void {
  fn(node);
  for (const child of node.children) walk(child, fn);
}

function childText(node: SyntaxNode, field: string): string {
  return node.childForFieldName(field)?.text ?? '';
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

function extractExports(root: SyntaxNode): RawExport[] {
  const exports: RawExport[] = [];

  walk(root, (node) => {
    if (node.type !== 'export_statement') return;

    const startLine = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const isDefault = node.children.some((c) => c.type === 'default');

    for (const child of node.namedChildren) {
      switch (child.type) {
        case 'function_declaration': {
          const name = childText(child, 'name') || 'default';
          exports.push({ name, kind: 'function', isDefault, startLine, endLine });
          break;
        }
        case 'class_declaration': {
          const name = childText(child, 'name') || 'default';
          exports.push({ name, kind: 'class', isDefault, startLine, endLine });
          break;
        }
        case 'lexical_declaration':
        case 'variable_declaration': {
          for (const decl of child.namedChildren) {
            if (decl.type !== 'variable_declarator') continue;
            const name = childText(decl, 'name');
            if (!name) continue;
            const value = decl.childForFieldName('value');
            const kind = value && (value.type === 'arrow_function' || value.type === 'function')
              ? 'function' : 'const';
            exports.push({ name, kind, isDefault: false, startLine, endLine });
          }
          break;
        }
        case 'type_alias_declaration': {
          const name = childText(child, 'name');
          if (name) exports.push({ name, kind: 'type', isDefault, startLine, endLine });
          break;
        }
        case 'interface_declaration': {
          const name = childText(child, 'name');
          if (name) exports.push({ name, kind: 'interface', isDefault, startLine, endLine });
          break;
        }
        case 'arrow_function':
        case 'function': {
          // export default () => {}
          if (isDefault) exports.push({ name: 'default', kind: 'function', isDefault: true, startLine, endLine });
          break;
        }
      }
    }
  });

  return exports;
}

// ---------------------------------------------------------------------------
// Re-export extraction  (export { X } from '...' | export * from '...')
// ---------------------------------------------------------------------------

function extractReExports(root: SyntaxNode): RawReExport[] {
  const reExports: RawReExport[] = [];

  walk(root, (node) => {
    if (node.type !== 'export_statement') return;

    // Must have a source string: export ... from '...'
    const sourceNode = node.namedChildren.find((c) => c.type === 'string');
    if (!sourceNode) return;
    const source = sourceNode.text.replace(/['"]/g, '');

    // export * from '...' or export * as ns from '...'
    const hasStar = node.children.some((c) => c.type === '*');
    if (hasStar) {
      reExports.push({ source, names: [] }); // empty = wildcard
      return;
    }

    // export { X, Y as Z } from '...'
    const clause = node.namedChildren.find((c) => c.type === 'export_clause');
    if (!clause) return;

    const names: string[] = [];
    for (const spec of clause.namedChildren) {
      if (spec.type !== 'export_specifier') continue;
      // The exported name (alias if present, otherwise original)
      const alias = spec.childForFieldName('alias');
      const original = spec.childForFieldName('name');
      const exportedAs = alias ?? original;
      if (exportedAs) names.push(exportedAs.text);
    }
    if (names.length) reExports.push({ source, names });
  });

  return reExports;
}

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

function extractImports(root: SyntaxNode): RawImport[] {
  const imports: RawImport[] = [];

  walk(root, (node) => {
    if (node.type !== 'import_statement') return;

    const source = node.childForFieldName('source')?.text?.replace(/['"]/g, '') ?? '';
    if (!source) return;

    const names: string[] = [];
    for (const child of node.namedChildren) {
      if (child.type === 'import_clause') {
        // default import
        const def = child.childForFieldName('name');
        if (def) names.push(def.text);
        // named imports
        for (const sub of child.namedChildren) {
          if (sub.type === 'named_imports') {
            for (const specifier of sub.namedChildren) {
              if (specifier.type === 'import_specifier') {
                const alias = specifier.childForFieldName('alias');
                const n = alias ?? specifier.childForFieldName('name');
                if (n) names.push(n.text);
              }
            }
          }
          if (sub.type === 'namespace_import') {
            const ns = sub.namedChildren.find((c) => c.type === 'identifier');
            if (ns) names.push(`* as ${ns.text}`);
          }
        }
      }
    }

    imports.push({ source, names });
  });

  return imports;
}

// ---------------------------------------------------------------------------
// JSX component usage
// ---------------------------------------------------------------------------

function extractJsxUsed(root: SyntaxNode): string[] {
  const used = new Set<string>();

  walk(root, (node) => {
    if (node.type !== 'jsx_opening_element' && node.type !== 'jsx_self_closing_element') return;
    const nameNode = node.childForFieldName('name') ?? node.namedChildren[0];
    if (!nameNode) return;
    const name = nameNode.text.split('.')[0]; // handle <Foo.Bar> → Foo
    // Only track PascalCase (React components, not HTML tags)
    if (name && /^[A-Z]/.test(name)) used.add(name);
  });

  return Array.from(used);
}

// ---------------------------------------------------------------------------
// Directive detection
// ---------------------------------------------------------------------------

function extractDirective(root: SyntaxNode): 'use client' | 'use server' | null {
  // Must be the first expression statement in the file
  for (const child of root.namedChildren) {
    if (child.type === 'expression_statement') {
      const text = child.text.replace(/['";\s]/g, '');
      if (text === 'useclient') return 'use client';
      if (text === 'useserver') return 'use server';
    }
    break; // only check the first statement
  }
  return null;
}

// ---------------------------------------------------------------------------
// Props detection (for component detection)
// ---------------------------------------------------------------------------

export function extractPropNames(root: SyntaxNode): string[] {
  const propNames: string[] = [];

  walk(root, (node) => {
    if (node.type !== 'interface_declaration' && node.type !== 'type_alias_declaration') return;
    const name = childText(node, 'name');
    if (!/Props$|Properties$/.test(name)) return;

    if (node.type === 'interface_declaration') {
      const body = node.childForFieldName('body');
      if (body) {
        for (const member of body.namedChildren) {
          if (member.type === 'property_signature') {
            const propName = childText(member, 'name');
            if (propName) propNames.push(propName);
          }
        }
      }
    }
  });

  return propNames.slice(0, 15);
}

// ---------------------------------------------------------------------------
// Main parse entry point
// ---------------------------------------------------------------------------

export function parseFile(absolutePath: string, relativePath: string, contentHash: string): ParsedFile | null {
  let source: string;
  try {
    source = fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }

  const isTsx = absolutePath.endsWith('.tsx') || absolutePath.endsWith('.jsx');
  const parser = isTsx ? getTsxParser() : getTsParser();

  let tree: { rootNode: SyntaxNode };
  try {
    tree = parser.parse(source);
  } catch {
    return fallbackParse(absolutePath, relativePath, contentHash, source);
  }

  const root = tree.rootNode;

  return {
    path: absolutePath,
    relativePath,
    exports: extractExports(root),
    imports: extractImports(root),
    reExports: extractReExports(root),
    jsxUsed: extractJsxUsed(root),
    directive: extractDirective(root),
    linesOfCode: root.endPosition.row + 1,
    contentHash,
  };
}

// ---------------------------------------------------------------------------
// Fallback (regex-based) for files tree-sitter can't parse
// ---------------------------------------------------------------------------

function fallbackParse(
  absolutePath: string,
  relativePath: string,
  contentHash: string,
  source: string,
): ParsedFile {
  const exports: RawExport[] = [];
  const imports: RawImport[] = [];

  for (const m of source.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    if (m[1]) exports.push({ name: m[1], kind: 'unknown', isDefault: false, startLine: 0, endLine: 0 });
  }

  for (const m of source.matchAll(/import\s+[^'"]+from\s+['"]([^'"]+)['"]/g)) {
    if (m[1]) imports.push({ source: m[1], names: [] });
  }

  const directiveMatch = source.trimStart().match(/^['"]use (client|server)['"]/);
  const directive = directiveMatch ? (`use ${directiveMatch[1]}` as 'use client' | 'use server') : null;

  return {
    path: absolutePath,
    relativePath,
    exports,
    imports,
    reExports: [],
    jsxUsed: [],
    directive,
    linesOfCode: source.split('\n').length,
    contentHash,
  };
}
