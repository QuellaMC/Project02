import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { onTestFinished } from 'vitest';

export function createTestTempRoot(prefix = 'project02-test-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  return root;
}
