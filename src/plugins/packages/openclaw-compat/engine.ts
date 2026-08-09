import {createRequire} from 'node:module';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

import {isRecord} from '../../api/validation-primitives.ts';

/**
 * Pinned v1 of the OpenClaw context-engine plugin surface this compat
 * adapter understands: a default register function that registers engines
 * exposing info/assemble/ingest and an optional dispose. Their interface
 * has moved before and will move again; a mismatch fails construction
 * instead of guessing.
 */
export type OpenClawContextEngineV1 = {
  readonly info: {readonly id: string};
  assemble(params: {
    readonly sessionId: string;
    readonly sessionKey: string;
    readonly messages: readonly {
      readonly role: 'user' | 'assistant';
      readonly content: string;
    }[];
    readonly tokenBudget: number;
    readonly availableTools: readonly string[];
    readonly citationsMode: 'off';
  }): unknown;
  ingest(params: {
    readonly sessionId: string;
    readonly message: {
      readonly role: 'user' | 'assistant';
      readonly content: string;
    };
    readonly isHeartbeat: boolean;
  }): unknown;
  dispose?(): unknown;
};

const nativeImportModule: unknown = createRequire(import.meta.url)(
  '../../package-loader/native-import.cjs',
);

function nativeImport(specifier: string): Promise<unknown> {
  if (typeof nativeImportModule !== 'function') {
    throw new TypeError('Native import bridge is unavailable.');
  }

  const result: unknown = Reflect.apply(nativeImportModule, undefined, [
    specifier,
  ]);

  return Promise.resolve(result);
}

export async function loadOpenClawContextEngine(options: {
  readonly modulePath: string;
  readonly engineId?: string;
  readonly storeRoot: string;
}): Promise<OpenClawContextEngineV1> {
  if (!isAbsolute(options.modulePath)) {
    throw new TypeError(
      'openclaw-compat modulePath must be an absolute path to the plugin module.',
    );
  }

  // Importing the configured module executes operator-trusted code, the
  // same trust an installed operator package already gets.
  const moduleNamespace = await nativeImport(
    pathToFileURL(options.modulePath).href,
  );
  const register = isRecord(moduleNamespace)
    ? moduleNamespace['default']
    : undefined;

  if (typeof register !== 'function') {
    throw new TypeError(
      'openclaw-compat module does not export a default register function.',
    );
  }

  const factories = new Map<string, unknown>();

  Reflect.apply(register, undefined, [
    {
      registerContextEngine(id: unknown, factory: unknown) {
        if (typeof id === 'string' && id.length > 0) {
          factories.set(id, factory);
        }
      },
    },
  ]);

  const engineId = options.engineId ?? [...factories.keys()][0];
  const factory = engineId === undefined ? undefined : factories.get(engineId);

  if (engineId === undefined || factory === undefined) {
    throw new TypeError(
      options.engineId === undefined
        ? 'openclaw-compat module registered no context engines.'
        : `openclaw-compat module registered no context engine "${options.engineId}".`,
    );
  }

  if (typeof factory !== 'function') {
    throw new TypeError(
      `openclaw-compat engine "${engineId}" factory is not a function.`,
    );
  }

  const engine: unknown = await Promise.resolve(
    Reflect.apply(factory, undefined, [
      {
        config: {},
        agentDir: options.storeRoot,
        workspaceDir: options.storeRoot,
      },
    ]),
  );

  return pinnedContextEngine(engineId, engine);
}

function pinnedContextEngine(
  engineId: string,
  engine: unknown,
): OpenClawContextEngineV1 {
  const missing = (member: string): TypeError =>
    new TypeError(
      `openclaw-compat engine "${engineId}" does not implement pinned v1 member "${member}".`,
    );

  if (!isRecord(engine)) {
    throw new TypeError(
      `openclaw-compat engine "${engineId}" factory did not return an engine object.`,
    );
  }

  const info = engine['info'];

  if (!isRecord(info) || typeof info['id'] !== 'string') {
    throw missing('info.id');
  }

  if (typeof engine['assemble'] !== 'function') {
    throw missing('assemble');
  }

  if (typeof engine['ingest'] !== 'function') {
    throw missing('ingest');
  }

  if (
    engine['dispose'] !== undefined &&
    typeof engine['dispose'] !== 'function'
  ) {
    throw missing('dispose');
  }

  const assemble = engine['assemble'];
  const ingest = engine['ingest'];
  const dispose = engine['dispose'];

  return Object.freeze({
    info: Object.freeze({id: info['id']}),
    assemble(params) {
      const result: unknown = Reflect.apply(assemble, engine, [params]);

      return result;
    },
    ingest(params) {
      const result: unknown = Reflect.apply(ingest, engine, [params]);

      return result;
    },
    ...(dispose === undefined
      ? {}
      : {
          dispose() {
            const result: unknown = Reflect.apply(dispose, engine, []);

            return result;
          },
        }),
  } satisfies OpenClawContextEngineV1);
}

export function assembledSystemPromptAddition(
  result: unknown,
): string | undefined {
  if (!isRecord(result)) {
    return undefined;
  }

  const addition = result['systemPromptAddition'];

  return typeof addition === 'string' && addition.trim().length > 0
    ? addition
    : undefined;
}
