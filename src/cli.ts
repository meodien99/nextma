#!/usr/bin/env node

import * as path from 'path';
import * as fs from 'fs';
import { Command } from 'commander';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { scan, ScanPhase } from './scanner/index.js';
import { runFigmaWizard, closeWizard } from './figma/wizard.js';
import { parseFigmaUrl, loadFigmaToken, fetchFigmaNode, fetchFigmaImageBase64 } from './figma/api.js';
import { normalizeFigmaNode } from './figma/normalize.js';
import { flattenTokenColors } from './figma/colors.js';
import {
  renderDesignIntent,
  renderCodegenGuide,
  renderPrepareGuide,
  renderUpdateGuide,
  renderRootCodegenGuide,
} from './figma/codegen.js';
import { openDb, getScanMeta } from './db/index.js';
import { writeFigmaNode } from './figma/graph.js';
import { startMcpServer } from './mcp/server.js';
import { startVisualizeServer } from './visualize/server.js';

const program = new Command();

program
  .name('nextma')
  .description('Next.js codebase knowledge graph')
  .version('2.0.0');

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

program
  .command('scan')
  .description('Scan a Next.js project and build the knowledge graph')
  .option('--root <path>', 'Project root directory', '.')
  .option('--out <path>', 'Output directory', '.context')
  .option('--instruction <file>', 'Append nextma MCP instructions to a file (e.g. CLAUDE.md, .cursorrules)')
  .action(async (opts) => {
    const root = path.resolve(opts.root);
    const out = path.resolve(opts.out);

    console.log(`\nScanning: ${root}`);
    console.log(`Output:   ${out}\n`);

    const phases: Record<ScanPhase, string> = {
      discovering: 'Discovering files',
      parsing:     'Parsing',
      extracting:  'Extracting',
      resolving:   'Resolving relations',
      nextjs:      'Next.js analysis',
      scoring:     'Scoring',
      done:        'Done',
    };

    let lastPhase = '';

    try {
      const meta = await scan(root, out, { incremental: false, instructionFile: opts.instruction }, (phase, current, total, label) => {
        const name = phases[phase] ?? phase;
        if (phase !== lastPhase) { lastPhase = phase; process.stdout.write(`  ${name}…`); }
        if (phase === 'done') process.stdout.write(' ✓\n');
        else if (total > 1 && label) process.stdout.write(`\r  ${name}… ${label}   `);
      });

      console.log(`\n  ${meta.totalNodes} nodes  ${meta.totalEdges} edges`);
      console.log(`  Router: ${meta.routerKind}  TypeScript: ${meta.hasTypeScript}`);
      console.log(`\n  Written to: ${path.join(out, 'graph.db')}`);
    } catch (err) {
      console.error('\nScan failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// refresh (incremental)
// ---------------------------------------------------------------------------

program
  .command('refresh')
  .description('Incrementally re-scan changed files')
  .option('--root <path>', 'Project root directory', '.')
  .option('--out <path>', 'Output directory', '.context')
  .option('--instruction <file>', 'Append nextma MCP instructions to a file (e.g. CLAUDE.md, .cursorrules)')
  .action(async (opts) => {
    const root = path.resolve(opts.root);
    const out = path.resolve(opts.out);
    const dbPath = path.join(out, 'graph.db');

    if (!fs.existsSync(dbPath)) {
      console.error('No graph.db found. Run `nextma scan` first.');
      process.exit(1);
    }

    console.log(`\nRefreshing: ${root}\n`);

    try {
      const meta = await scan(root, out, { incremental: true, instructionFile: opts.instruction }, (phase, _c, _t, label) => {
        if (label) process.stdout.write(`\r  ${phase}… ${label}   `);
        else process.stdout.write(`  ${phase}…\n`);
      });
      console.log(`\n  ${meta.totalNodes} nodes  ${meta.totalEdges} edges`);
    } catch (err) {
      console.error('\nRefresh failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// figma-parse
// ---------------------------------------------------------------------------

program
  .command('figma-parse [url]')
  .description('Parse a Figma node and generate a codegen guide')
  .action(async (urlArg?: string) => {
    try {
      const wizard = await runFigmaWizard(urlArg);
      const { componentName, componentSlug, figmaUrl, outputDir, isUpdate, existingFilePath } = wizard;

      const outBase = path.resolve(outputDir);
      const figmaRootDir = path.join(outBase, 'figma');
      const figmaDir = path.join(figmaRootDir, componentSlug);
      const alreadyExists = fs.existsSync(figmaDir);

      if (!isUpdate && alreadyExists) {
        console.log(`\n  Note: ${figmaDir} already exists.`);
        console.log(`  To update an existing component, use: nextma figma-parse --update`);
        console.log(`  Proceeding will overwrite all files including codegen-guide.md.\n`);
      }

      fs.mkdirSync(figmaDir, { recursive: true });

      // Load design tokens from graph.db if available
      const dbPath = path.join(outBase, 'graph.db');
      let tokenColorEntries: ReturnType<typeof flattenTokenColors> | undefined;
      let routerKind: string | undefined;
      let hasTypeScript: boolean | undefined;
      let db: ReturnType<typeof openDb> | null = null;

      if (fs.existsSync(dbPath)) {
        db = openDb(outBase);
        const meta = getScanMeta(db);
        routerKind = meta?.routerKind;
        hasTypeScript = meta?.hasTypeScript;

        // Read resolved color tokens from graph.db (resolved during scan phase)
        const colorRows = db.prepare(
          `SELECT name, json(properties) as props FROM nodes WHERE label = 'DesignToken'`
        ).all() as Array<{ name: string; props: string }>;

        const colorHexMap: Record<string, string> = {};
        for (const row of colorRows) {
          const p = JSON.parse(row.props) as { tokenCategory?: string; resolvedHex?: string };
          if (p.tokenCategory === 'colors' && p.resolvedHex) {
            // name is "colors.neutral-300" → strip prefix to get "neutral-300"
            colorHexMap[row.name.replace(/^colors\./, '')] = p.resolvedHex;
          }
        }
        if (Object.keys(colorHexMap).length > 0) {
          tokenColorEntries = flattenTokenColors(colorHexMap);
        }
      }

      // Fetch + normalize Figma node
      const token = loadFigmaToken();
      const ref = parseFigmaUrl(figmaUrl)!;

      process.stdout.write('  Fetching Figma node…\n');
      const apiNode = await fetchFigmaNode(token, ref);
      const normalized = normalizeFigmaNode(apiNode.document, apiNode.styles);

      // Fetch preview image
      process.stdout.write('  Fetching preview image…\n');
      const image = await fetchFigmaImageBase64(token, ref);
      if (image) {
        fs.writeFileSync(path.join(figmaDir, 'preview.png'), Buffer.from(image.base64, 'base64'));
        process.stdout.write('  preview.png saved\n');
      } else {
        process.stdout.write('  preview.png unavailable\n');
      }

      // Write meta.json
      fs.writeFileSync(
        path.join(figmaDir, 'meta.json'),
        JSON.stringify({ figmaUrl, fileKey: ref.fileKey, nodeId: ref.nodeId, componentName, componentSlug }, null, 2) + '\n',
      );

      // Write figma-node.json
      fs.writeFileSync(path.join(figmaDir, 'figma-node.json'), JSON.stringify(normalized, null, 2) + '\n');

      // Write design-intent.md
      const imageRef = image ? `![Preview](./preview.png)\n\n` : '';
      fs.writeFileSync(
        path.join(figmaDir, 'design-intent.md'),
        imageRef + renderDesignIntent(normalized, tokenColorEntries),
      );

      // Write codegen-guide.md — skip on update (user may have edited it)
      const codegenGuidePath = path.join(figmaDir, 'codegen-guide.md');
      if (!isUpdate || !fs.existsSync(codegenGuidePath)) {
        fs.writeFileSync(
          codegenGuidePath,
          renderCodegenGuide({ componentName, componentSlug, figmaUrl, normalized, tokenColorEntries, routerKind, hasTypeScript }),
        );
      } else {
        process.stdout.write('  codegen-guide.md preserved (use --update)\n');
      }

      // Write prepare.md (new) or update-guide.md (update)
      if (isUpdate) {
        fs.writeFileSync(
          path.join(figmaDir, 'update-guide.md'),
          renderUpdateGuide(componentName, componentSlug, figmaDir, outBase, existingFilePath),
        );
      } else {
        fs.writeFileSync(
          path.join(figmaDir, 'prepare.md'),
          renderPrepareGuide(componentName, componentSlug, figmaDir, outBase),
        );
      }

      // Write root codegen-guide.md if not exists
      const rootGuide = path.join(figmaRootDir, 'codegen-guide.md');
      if (!fs.existsSync(rootGuide)) {
        fs.writeFileSync(rootGuide, renderRootCodegenGuide());
        process.stdout.write('  Created root figma/codegen-guide.md\n');
      }

      // Write FigmaNode to graph.db
      if (db) {
        process.stdout.write('  Linking to graph…\n');
        writeFigmaNode(db, {
          figmaUrl,
          fileKey: ref.fileKey,
          nodeId: ref.nodeId,
          componentName,
          componentSlug,
          normalized,
        });
        db.close();
      }

      const guideFile = isUpdate ? 'update-guide.md' : 'prepare.md';
      console.log(`\n  Written to: ${figmaDir}`);
      console.log(`    meta.json, figma-node.json, preview.png`);
      console.log(`    design-intent.md${isUpdate ? ' (refreshed)' : ', codegen-guide.md'}, ${guideFile}`);
      console.log(`\nNext: open Claude Code and run:`);
      console.log(`  "Read ${path.join(figmaDir, guideFile)} and follow the steps"`);
    } catch (err) {
      closeWizard();
      console.error('\nfigma-parse failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

program
  .command('mcp')
  .description('Start the MCP server (stdio transport)')
  .option('--out <path>', 'Context directory containing graph.db', '.context')
  .option('--root <path>', 'Project root (for scan_repo tool)', '.')
  .action(async (opts) => {
    try {
      await startMcpServer(path.resolve(opts.out), path.resolve(opts.root));
    } catch (err) {
      console.error('MCP server error:', err);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// visualize
// ---------------------------------------------------------------------------

program
  .command('visualize')
  .description('Open a local graph visualization in the browser')
  .option('--out <path>', 'Context directory containing graph.db', '.context')
  .option('--port <number>', 'Port to serve on', '4321')
  .action(async (opts) => {
    const contextDir = path.resolve(opts.out);
    const port = parseInt(opts.port, 10);
    const dbPath = path.join(contextDir, 'graph.db');

    if (!fs.existsSync(dbPath)) {
      console.error('No graph.db found. Run `nextma scan` first.');
      process.exit(1);
    }

    const server = startVisualizeServer(contextDir, port);
    const url = `http://localhost:${port}`;
    console.log(`\n  Graph viewer: ${url}\n`);

    // Open browser
    const { execFile } = await import('child_process');
    const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execFile(open, [url]);

    // Keep alive
    process.on('SIGINT', () => { server.close(); process.exit(0); });
  });

program.parse(process.argv);
