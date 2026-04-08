import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';

// ---------------------------------------------------------------------------
// Minimal readline-based wizard helpers
// ---------------------------------------------------------------------------

let rl: ReturnType<typeof readline.createInterface> | null = null;

function getReadline() {
  if (!rl) {
    rl = readline.createInterface({ input, output, terminal: false });
  }
  return rl;
}

export function closeWizard(): void {
  rl?.close();
  rl = null;
}

async function ask(question: string, defaultValue = ''): Promise<string> {
  const hint = defaultValue ? ` (${defaultValue})` : '';
  process.stdout.write(`? ${question}${hint}: `);
  const answer = await getReadline().question('');
  return answer.trim() || defaultValue;
}

// ---------------------------------------------------------------------------
// Wizard result type
// ---------------------------------------------------------------------------

export interface WizardResult {
  figmaUrl: string;
  fileKey: string;
  nodeId: string;
  componentName: string;
  componentSlug: string;
  outputDir: string;
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

import { parseFigmaUrl, loadFigmaToken, fetchFigmaNode } from './api';

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function runFigmaWizard(urlArg?: string): Promise<WizardResult> {
  console.log('');

  // Step 1: Figma URL
  const rawUrl = urlArg ?? await ask('Figma URL');
  if (!rawUrl) throw new Error('Figma URL is required');

  const ref = parseFigmaUrl(rawUrl);
  if (!ref) throw new Error(`Could not parse Figma URL: ${rawUrl}`);

  // Step 2: Fetch node name from API
  const token = loadFigmaToken();
  if (!token) {
    throw new Error(
      'FIGMA_ACCESS_TOKEN not found.\n' +
      'Set it as an environment variable or add FIGMA_ACCESS_TOKEN=... to your .env file.'
    );
  }

  process.stdout.write(`  Fetching node from Figma API...\n`);
  const apiNode = await fetchFigmaNode(token, ref);
  const detectedName = apiNode.document.name;
  process.stdout.write(`  Found: "${detectedName}"\n\n`);

  // Step 3: Component name
  const componentName = await ask('Component name', detectedName);
  const componentSlug = slugify(componentName);

  // Step 4: Output directory
  const outputDir = await ask('Output directory', '.context');

  console.log('');
  closeWizard();

  return {
    figmaUrl: rawUrl,
    fileKey: ref.fileKey,
    nodeId: ref.nodeId,
    componentName,
    componentSlug,
    outputDir,
  };
}
