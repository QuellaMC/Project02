import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

describe('plugin type barrel startup safety', () => {
  it('does not pull runtime storage into chat CLI startup through plugins/types', () => {
    const result = spawnSync(process.execPath, ['src/cli/chat.ts', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).not.toContain('ReferenceError');
    expect(output).not.toContain(
      'Cannot access \'roleModelInvalidVisibleReplyRejectionReason\' before initialization'
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown chat option: --help.');
  });

  it('imports runtime local after role-model contracts without module initialization cycles', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "import('./src/role-model/contracts.ts').then(() => import('./src/runtime/local.ts'))"
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8'
      }
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).not.toContain('ReferenceError');
    expect(output).not.toContain(
      'Cannot access \'roleModelInvalidVisibleReplyRejectionReason\' before initialization'
    );
    expect(result.status).toBe(0);
  });
});
