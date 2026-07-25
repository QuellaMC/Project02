import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {onTestFinished} from 'vitest';

/**
 * Creates a temp root whose path is already canonical.
 *
 * `os.tmpdir()` is a symlink on macOS (`/var/...` -> `/private/var/...`) and a
 * real directory on Linux. Storage and package code canonicalizes every path it
 * trusts, so a raw `mkdtempSync` root makes tests compare canonicalized runtime
 * output against a non-canonical fixture path — passing on one platform and
 * failing on the other. Canonicalizing at the seam that hands out the root
 * keeps fixture paths and runtime paths the same string everywhere.
 */
export function createTestTempRoot(prefix = 'project02-test-'): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

  onTestFinished(() => {
    rmSync(root, {recursive: true, force: true});
  });

  return root;
}
