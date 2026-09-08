import {spawnSync} from 'node:child_process';

import {describe, expect, it} from 'vitest';

describe('plugin type barrel startup safety', () => {
  it('does not pull runtime storage into chat CLI startup through plugins/types', () => {
    const result = spawnSync(
      process.execPath,
      ['src/cli/chat/main.ts', '--help'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).not.toContain('ReferenceError');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown chat option: --help.');
  });

  it('starts the daemon entry without module initialization cycles', () => {
    const result = spawnSync(
      process.execPath,
      ['src/cli/serve/main.ts', '--help'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).not.toContain('ReferenceError');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown serve option: --help.');
  });

  it('imports runtime local after role-model contracts without module initialization cycles', () => {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "import('./src/role-model/index.ts').then(() => import('./src/runtime/turn/local.ts'))",
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).not.toContain('ReferenceError');
    expect(result.status).toBe(0);
  });

  it.each([
    [
      './src/plugins/api/index.ts',
      './src/plugins/policy/tool-policy.ts',
      './src/plugins/builtin/plugin-management/index.ts',
    ],
    [
      './src/plugins/builtin/plugin-management/index.ts',
      './src/plugins/api/index.ts',
      './src/plugins/policy/tool-policy.ts',
    ],
    [
      './src/plugins/policy/tool-policy.ts',
      './src/plugins/builtin/plugin-management/index.ts',
      './src/plugins/api/index.ts',
    ],
  ])(
    'imports plugin construction and policy modules in order %j',
    (...modules) => {
      const importChain = modules
        .map(modulePath => `import(${JSON.stringify(modulePath)})`)
        .join('.then(() => ')
        .concat(')'.repeat(modules.length - 1));
      const result = spawnSync(process.execPath, ['-e', importChain], {
        cwd: process.cwd(),
        encoding: 'utf8',
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(output).not.toContain('ReferenceError');
      expect(result.status).toBe(0);
    },
  );
});
