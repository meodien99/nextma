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

async function choose(question: string, options: string[], defaultIndex = 0): Promise<number> {
  process.stdout.write(`? ${question}\n`);
  options.forEach((opt, i) => process.stdout.write(`  ${i + 1}) ${opt}\n`));
  process.stdout.write(`  Enter choice [${defaultIndex + 1}]: `);
  const answer = (await getReadline().question('')).trim();
  const n = parseInt(answer, 10);
  if (!answer) return defaultIndex;
  if (isNaN(n) || n < 1 || n > options.length) return defaultIndex;
  return n - 1;
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
  mode: 'static' | 'llm';
  provider?: 'claude' | 'openai';
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

  // Step 5: Mode
  const modeIdx = await choose('Mode', [
    'Static  (fast, no LLM)',
    'Static + LLM enrichment',
  ]);
  const mode: 'static' | 'llm' = modeIdx === 1 ? 'llm' : 'static';

  // Step 8: Provider (only if LLM mode)
  let provider: 'claude' | 'openai' | undefined;
  if (mode === 'llm') {
    const providerIdx = await choose('Provider', [
      'Claude (recommended)',
      'OpenAI',
    ]);
    provider = providerIdx === 1 ? 'openai' : 'claude';
  }

  console.log('');
  closeWizard();

  return {
    figmaUrl: rawUrl,
    fileKey: ref.fileKey,
    nodeId: ref.nodeId,
    componentName,
    componentSlug,
    outputDir,
    mode,
    provider,
  };
}
