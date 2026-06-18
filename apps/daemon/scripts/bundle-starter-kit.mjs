import { cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `tsc` emits only the compiled JS, but the seeder reads the starter-kit
// template tree at runtime (resolved relative to the compiled module). Copy the
// template into dist so a built artifact (e.g. the Docker image that ships dist)
// finds it, not just `tsx`/dev running against src. Recursive + overwriting, so
// the kit can grow by dropping files in with no change here.
cpSync(
  fileURLToPath(new URL('../src/starter-kit-template', import.meta.url)),
  fileURLToPath(new URL('../dist/starter-kit-template', import.meta.url)),
  { recursive: true }
);
