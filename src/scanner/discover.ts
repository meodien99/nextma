import fg from 'fast-glob';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Ignore patterns
// ---------------------------------------------------------------------------

const ALWAYS_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/.turbo/**',
  '**/.cache/**',
  '**/.vercel/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.stories.*',
  '**/.vscode/**',
  '**/.idea/**',
  '**/.storybook/**',
  '**/.husky/**',
  '**/.github/**',
];

// ---------------------------------------------------------------------------
// Discovered file
// ---------------------------------------------------------------------------

export interface DiscoveredFile {
  absolutePath: string;
  relativePath: string;
  contentHash: string;
  zone: 'source' | 'route';  // source = deep scan, route = shallow (pages/app)
}

// ---------------------------------------------------------------------------
// Discover all source files in a Next.js project
// ---------------------------------------------------------------------------

export async function discoverFiles(projectRoot: string): Promise<DiscoveredFile[]> {
  const abs = path.resolve(projectRoot);

  // Source files (deep scan zones)
  const sourcePatterns = [
    'src/components/**/*.{ts,tsx,js,jsx}',
    'src/lib/**/*.{ts,tsx,js,jsx}',
    'src/store/**/*.{ts,tsx,js,jsx}',
    'src/hooks/**/*.{ts,tsx,js,jsx}',
    'src/services/**/*.{ts,tsx,js,jsx}',
    'src/data/**/*.{ts,tsx,js,jsx}',
    'src/utils/**/*.{ts,tsx,js,jsx}',
    'src/api/**/*.{ts,tsx,js,jsx}',
    'src/context/**/*.{ts,tsx,js,jsx}',
    'src/providers/**/*.{ts,tsx,js,jsx}',
    'components/**/*.{ts,tsx,js,jsx}',
    'lib/**/*.{ts,tsx,js,jsx}',
    'hooks/**/*.{ts,tsx,js,jsx}',
    'utils/**/*.{ts,tsx,js,jsx}',
  ];

  // Route files (shallow scan zones — app router + pages router)
  const routePatterns = [
    'src/app/**/*.{ts,tsx,js,jsx}',
    'app/**/*.{ts,tsx,js,jsx}',
    'src/pages/**/*.{ts,tsx,js,jsx}',
    'pages/**/*.{ts,tsx,js,jsx}',
  ];

  const [sourceFiles, routeFiles] = await Promise.all([
    fg(sourcePatterns, { cwd: abs, absolute: true, ignore: ALWAYS_IGNORE }),
    fg(routePatterns, { cwd: abs, absolute: true, ignore: ALWAYS_IGNORE }),
  ]);

  // Deduplicate — a file matched by both gets classified as 'route'
  const seen = new Set<string>();
  const results: DiscoveredFile[] = [];

  for (const absolutePath of routeFiles) {
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    results.push({
      absolutePath,
      relativePath: path.relative(abs, absolutePath),
      contentHash: hashFile(absolutePath),
      zone: 'route',
    });
  }

  for (const absolutePath of sourceFiles) {
    if (seen.has(absolutePath)) continue;
    seen.add(absolutePath);
    results.push({
      absolutePath,
      relativePath: path.relative(abs, absolutePath),
      contentHash: hashFile(absolutePath),
      zone: 'source',
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashFile(absolutePath: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
  } catch {
    return '';
  }
}

export function detectRouterKind(projectRoot: string): 'app' | 'pages' | 'mixed' | 'unknown' {
  const abs = path.resolve(projectRoot);
  const hasApp = fs.existsSync(path.join(abs, 'app')) || fs.existsSync(path.join(abs, 'src', 'app'));
  const hasPages = fs.existsSync(path.join(abs, 'pages')) || fs.existsSync(path.join(abs, 'src', 'pages'));
  if (hasApp && hasPages) return 'mixed';
  if (hasApp) return 'app';
  if (hasPages) return 'pages';
  return 'unknown';
}

export function detectTypeScript(projectRoot: string): boolean {
  return fs.existsSync(path.join(path.resolve(projectRoot), 'tsconfig.json'));
}
