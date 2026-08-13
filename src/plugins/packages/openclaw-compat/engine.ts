import {isRecord} from '../../api/validation-primitives.ts';
import {RuntimePluginConstructionError} from '../../api/construction-error.ts';
import {importOperatorConfiguredModule} from '../../package-loader/native-import.ts';

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

export async function loadOpenClawContextEngine(options: {
  readonly modulePath: string;
  readonly engineId?: string;
  readonly engineConfig?: Readonly<Record<string, unknown>>;
  readonly storeRoot: string;
}): Promise<OpenClawContextEngineV1> {
  const moduleNamespace = await importOperatorConfiguredModule({
    subject: 'openclaw-compat',
    modulePath: options.modulePath,
  });
  const register = isRecord(moduleNamespace)
    ? moduleNamespace['default']
    : undefined;

  if (typeof register !== 'function') {
    throw new RuntimePluginConstructionError(
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

  if (options.engineId === undefined && factories.size > 1) {
    throw new RuntimePluginConstructionError(
      `openclaw-compat module registered ${String(factories.size)} context ` +
        `engines (${[...factories.keys()].join(', ')}); set the engineId ` +
        'config field to choose one.',
    );
  }

  const engineId = options.engineId ?? [...factories.keys()][0];
  const factory = engineId === undefined ? undefined : factories.get(engineId);

  if (engineId === undefined || factory === undefined) {
    throw new RuntimePluginConstructionError(
      options.engineId === undefined
        ? 'openclaw-compat module registered no context engines.'
        : `openclaw-compat module registered no context engine "${options.engineId}".`,
    );
  }

  if (typeof factory !== 'function') {
    throw new RuntimePluginConstructionError(
      `openclaw-compat engine "${engineId}" factory is not a function.`,
    );
  }

  const engine: unknown = await Promise.resolve(
    Reflect.apply(factory, undefined, [
      {
        config: options.engineConfig ?? {},
        agentDir: options.storeRoot,
        workspaceDir: options.storeRoot,
      },
    ]),
  );

  try {
    return pinnedContextEngine(engineId, engine);
  } catch (error: unknown) {
    // The factory has already opened whatever the engine holds -- a
    // database, a worker, a socket -- and a rejected engine that keeps
    // them can outlive the failed startup.
    await disposeRejectedEngine(engine);
    throw error;
  }
}

async function disposeRejectedEngine(engine: unknown): Promise<void> {
  const dispose = isRecord(engine) ? engine['dispose'] : undefined;

  if (typeof dispose !== 'function') {
    return;
  }

  try {
    await Promise.resolve(Reflect.apply(dispose, engine, []));
  } catch {
    // Best effort: the validation failure is what the operator must see.
  }
}

function pinnedContextEngine(
  engineId: string,
  engine: unknown,
): OpenClawContextEngineV1 {
  const missing = (member: string): RuntimePluginConstructionError =>
    new RuntimePluginConstructionError(
      `openclaw-compat engine "${engineId}" does not implement pinned v1 member "${member}".`,
    );

  if (!isRecord(engine)) {
    throw new RuntimePluginConstructionError(
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

/**
 * An engine may carry its assembly in the prompt addition, in the
 * assembled messages, or in both; dropping either half would silently
 * discard the engine's primary output. A result that does not match the
 * pinned shape fails loudly, because an incompatible engine reporting no
 * recall is indistinguishable from an engine with nothing to say.
 */
export function assembledContextText(options: {
  readonly result: unknown;
  readonly suppliedContents: readonly string[];
}): string | undefined {
  if (!isRecord(options.result)) {
    throw new TypeError(
      'openclaw-compat engine returned a non-object assembly; the configured module no longer matches pinned interface v1.',
    );
  }

  const addition = options.result['systemPromptAddition'];

  if (addition !== undefined && typeof addition !== 'string') {
    throw new TypeError(
      'openclaw-compat engine returned a non-string systemPromptAddition; the configured module no longer matches pinned interface v1.',
    );
  }

  const parts = [
    ...(typeof addition === 'string' ? [addition] : []),
    ...assembledMessageTexts(
      options.result['messages'],
      options.suppliedContents,
    ),
  ]
    .map(part => part.trim())
    .filter(part => part.length > 0);

  return parts.length === 0 ? undefined : parts.join('\n');
}

function assembledMessageTexts(
  value: unknown,
  suppliedContents: readonly string[],
): readonly string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TypeError(
      'openclaw-compat engine returned a non-array message assembly; the configured module no longer matches pinned interface v1.',
    );
  }

  return value.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry['content'] !== 'string') {
      throw new TypeError(
        'openclaw-compat engine returned an assembled message without string content; the configured module no longer matches pinned interface v1.',
      );
    }

    const content = entry['content'];

    // The engine assembles around the message it was handed; returning
    // that echo as memory would spend the recall budget re-telling the
    // model the prompt it already has.
    return suppliedContents.includes(content.trim()) ? [] : [content];
  });
}
