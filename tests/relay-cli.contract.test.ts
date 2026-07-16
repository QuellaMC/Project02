import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CharacterAgent } from '../src/core/conversation.ts';
import { runConfiguredRelayCli, runRelayCli } from '../src/cli/relay.ts';
import {
  createRuntimePluginHost,
  type RuntimePluginHost
} from '../src/plugins/host.ts';
import { runtimeConfigEnvVarName } from '../src/runtime/config/index.ts';
import {
  requiredDottedConfigPlugin,
  requiredSecretPlugin
} from './support/runtime-config-fixtures.ts';
import { collect, writeRuntimeConfig } from './support/runtime-config.ts';
import { createTestTempRoot } from './support/temp-root.ts';

describe('relay CLI compatibility wrapper', () => {
  it('prints exactly one non-interactive reply line', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await runRelayCli(['hello'], {
      pluginHost: createRuntimePluginHost(),
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect((chunk) => {
        stderr += chunk;
      })
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe("Mira: I'm here. Tell me what you need.\n");
  });

  it('ends the one-shot session through the injected startup host', async () => {
    const baseHost = createRuntimePluginHost();
    let sessionEndCalls = 0;
    const pluginHost = {
      ...baseHost,
      async onSessionEnd(context, hookOptions) {
        sessionEndCalls += 1;
        return await baseHost.onSessionEnd(context, hookOptions);
      }
    } satisfies RuntimePluginHost;

    const exitCode = await runRelayCli(['hello'], {
      pluginHost,
      stdout: collect(() => {}),
      stderr: collect(() => {})
    });

    expect(exitCode).toBe(0);
    expect(sessionEndCalls).toBe(1);
  });

  it('constructs the configured package host once before the production relay path', async () => {
    const storeRoot = createTestTempRoot('project02-configured-relay-');
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: { storeRoot }
    });
    let stdout = '';
    let stderr = '';

    const exitCode = await runConfiguredRelayCli(['hello'], {
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      env: { [runtimeConfigEnvVarName]: configPath },
      agent: createEchoAgent([])
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('Mira: heard hello\n');
  });

  it('redacts enabled package construction failures at relay startup', async () => {
    const storeRoot = createTestTempRoot('project02-relay-package-failure-');
    const plugin = requiredDottedConfigPlugin('operator.relay', 'endpoint');
    const packageRoot = join(storeRoot, 'plugins', plugin.manifest.id);
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: { storeRoot },
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: { endpoint: 'local' }
        }
      }
    });
    let stdout = '';
    let stderr = '';

    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ type: 'module' })}\n`,
      'utf8'
    );
    writeFileSync(
      join(packageRoot, 'project02.plugin.json'),
      `${JSON.stringify({
        format: 'project02.plugin.v1',
        entry: './index.mjs',
        manifest: plugin.manifest
      })}\n`,
      'utf8'
    );
    writeFileSync(
      join(packageRoot, 'index.mjs'),
      "throw new Error('private relay plugin detail');\n",
      'utf8'
    );

    const exitCode = await runConfiguredRelayCli(['hello'], {
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      env: { [runtimeConfigEnvVarName]: configPath },
      agent: createEchoAgent([])
    });

    expect(exitCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe(
      'Error: Runtime plugin construction failed before relay startup.\n'
    );
    expect(stderr).not.toContain('private relay plugin detail');
  });

  it('loads enabled package secrets from the selected runtime env file', async () => {
    const storeRoot = createTestTempRoot('project02-relay-runtime-env-');
    const plugin = requiredSecretPlugin('operator.relay-env');
    const packageRoot = join(storeRoot, 'plugins', plugin.manifest.id);
    const configPath = writeRuntimeConfig(join(storeRoot, 'config.json'), {
      project02: { storeRoot },
      plugins: {
        [plugin.manifest.id]: {
          enabled: true,
          config: { apiKey: { $env: 'OPERATOR_RELAY_API_KEY' } }
        }
      }
    });
    let stdout = '';
    let stderr = '';

    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      `${JSON.stringify({ type: 'module' })}\n`,
      'utf8'
    );
    writeFileSync(
      join(packageRoot, 'project02.plugin.json'),
      `${JSON.stringify({
        format: 'project02.plugin.v1',
        entry: './index.mjs',
        manifest: plugin.manifest
      })}\n`,
      'utf8'
    );
    writeFileSync(
      join(packageRoot, 'index.mjs'),
      [
        'export function createProject02Plugin(input) {',
        '  return { manifest: input.manifest, providedTools: [], lifecycleHooks: {} };',
        '}',
        ''
      ].join('\n'),
      'utf8'
    );
    writeFileSync(
      join(storeRoot, '.env'),
      'OPERATOR_RELAY_API_KEY=relay-runtime-secret\n',
      'utf8'
    );

    const exitCode = await runConfiguredRelayCli(['hello'], {
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect((chunk) => {
        stderr += chunk;
      }),
      env: { [runtimeConfigEnvVarName]: configPath },
      agent: createEchoAgent([])
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toBe('Mira: heard hello\n');
  });

  it('keeps the old pnpm separator form working', async () => {
    let stdout = '';

    const exitCode = await runRelayCli(['--', 'hello'], {
      pluginHost: createRuntimePluginHost(),
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect(() => {})
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("Mira: I'm here. Tell me what you need.\n");
  });

  it.each(['/exit', '/model-text'] as const)(
    'treats %s as relay message content',
    async (message) => {
      let stdout = '';
      let stderr = '';
      const observedMessages: string[] = [];

      const exitCode = await runRelayCli([message], {
        pluginHost: createRuntimePluginHost(),
        stdout: collect((chunk) => {
          stdout += chunk;
        }),
        stderr: collect((chunk) => {
          stderr += chunk;
        }),
        agent: createEchoAgent(observedMessages)
      });

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toBe(`Mira: heard ${message}\n`);
      expect(observedMessages).toEqual([message]);
    }
  );

  it('rejects missing input with the existing one-line message error', async () => {
    let stdout = '';
    let stderr = '';

    const exitCode = await runRelayCli([], {
      pluginHost: createRuntimePluginHost(),
      stdout: collect((chunk) => {
        stdout += chunk;
      }),
      stderr: collect((chunk) => {
        stderr += chunk;
      })
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('Error: Provide exactly one non-empty message.\n');
  });

  it('rejects multiline input with the existing one-line message error', async () => {
    let stderr = '';

    const exitCode = await runRelayCli(['hello\nthere'], {
      pluginHost: createRuntimePluginHost(),
      stdout: collect(() => {}),
      stderr: collect((chunk) => {
        stderr += chunk;
      })
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toBe(
      'Error: Provide exactly one non-empty single-line message.\n'
    );
  });
});

function createEchoAgent(observedMessages: string[]): CharacterAgent {
  return {
    reply(input) {
      observedMessages.push(input.message);

      return {
        text: `heard ${input.message}`
      };
    }
  };
}
