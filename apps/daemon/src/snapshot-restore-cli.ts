#!/usr/bin/env node
import { parseArgs } from 'node:util';

import { restoreSnapshotArchive } from './snapshot-restore.js';

try {
  const { values } = parseArgs({ options: { archive: { type: 'string' }, target: { type: 'string' } } });
  if (!values.archive || !values.target) throw new Error('Usage: kb1-restore --archive snapshot.zip --target /path/to/new-home');
  const result = await restoreSnapshotArchive({ archivePath: values.archive, targetHome: values.target });
  console.log(`Restored ${result.files} files (${result.bytes} bytes) into ${result.targetHome}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
