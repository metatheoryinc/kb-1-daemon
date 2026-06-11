import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const srcDir = fileURLToPath(new URL('./src', import.meta.url));
const generatedSourceArtifacts = findGeneratedSourceArtifacts(srcDir);

if (generatedSourceArtifacts.length > 0) {
  throw new Error([
    'Generated JavaScript/declaration artifacts must not live under packages/doc-session/src.',
    'They can satisfy .js import specifiers before Vitest transforms the TypeScript sources, making coverage misleading.',
    `Remove: ${generatedSourceArtifacts.join(', ')}`
  ].join('\n'));
}

export default defineConfig({
  resolve: {
    alias: {
      '@kb-2/vault-core': fileURLToPath(new URL('../vault-core/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      include: ['src/manager.ts', 'src/session.ts'],
      thresholds: {
        'src/manager.ts': {
          lines: 95
        },
        'src/session.ts': {
          lines: 90
        }
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
