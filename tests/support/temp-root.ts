import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {onTestFinished} from 'vitest';

// Nothing here may import production code: this module loads before a test's
// `vi.doMock('node:fs')` could intercept that graph.

// `os.tmpdir()` is a symlink on macOS and a real directory on Linux, so an
// uncanonicalized root splits fixture paths from canonicalized runtime paths.
export function createTestTempRoot(prefix = 'project02-test-'): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

  onTestFinished(() => {
    rmSync(root, {recursive: true, force: true});
  });

  return root;
}
