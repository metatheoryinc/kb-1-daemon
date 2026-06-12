import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const generatedSourceArtifacts = findGeneratedSourceArtifacts(srcDir);

if (generatedSourceArtifacts.length > 0) {
  throw new Error([
    'Generated JavaScript/declaration artifacts must not live under packages/vault-core/src.',
    'They can satisfy .js import specifiers before Vitest transforms the TypeScript sources, making coverage misleading.',
    `Remove: ${generatedSourceArtifacts.join(', ')}`
  ].join('\n'));
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      thresholds: {
        statements: 100,
        functions: 100,
        lines: 100,
        branches: 95
      }
    }
  }
});

function findGeneratedSourceArtifacts(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findGeneratedSourceArtifacts(absolutePath);
    if (!entry.isFile()) return [];
    if (!isGeneratedSourceArtifact(entry.name)) return [];
    return [path.relative(srcDir, absolutePath)];
  });
}

function isGeneratedSourceArtifact(filename: string): boolean {
  return filename.endsWith('.js') || filename.endsWith('.d.ts') || filename.endsWith('.d.ts.map');
}
