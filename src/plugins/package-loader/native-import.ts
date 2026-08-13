import {createRequire} from 'node:module';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

import {RuntimePluginConstructionError} from '../api/construction-error.ts';

type NativeDynamicImport = (specifier: string) => Promise<unknown>;

let nativeDynamicImport: NativeDynamicImport | undefined;

/** Node's own dynamic import, reached through a CJS bridge TypeScript keeps. */
export function requireNativeDynamicImport(): NativeDynamicImport {
  if (nativeDynamicImport !== undefined) {
    return nativeDynamicImport;
  }

  const nativeImportModule: unknown = createRequire(import.meta.url)(
    './native-import.cjs',
  );

  if (typeof nativeImportModule !== 'function') {
    throw new TypeError('Native runtime plugin importer is unavailable.');
  }

  nativeDynamicImport = specifier => {
    const result: unknown = Reflect.apply(nativeImportModule, undefined, [
      specifier,
    ]);

    return Promise.resolve(result);
  };

  return nativeDynamicImport;
}

/**
 * Imports a module an operator named in config, which executes
 * operator-trusted code — the same trust an installed package already gets.
 * A missing file, a syntax error, or an unresolved import inside it is the
 * operator's to fix, so it is reported as an actionable failure naming the
 * path instead of an anonymous construction error.
 */
export async function importOperatorConfiguredModule(options: {
  readonly subject: string;
  readonly modulePath: string;
}): Promise<unknown> {
  if (!isAbsolute(options.modulePath)) {
    throw new RuntimePluginConstructionError(
      `${options.subject} modulePath must be an absolute path to the module.`,
    );
  }

  try {
    return await requireNativeDynamicImport()(
      pathToFileURL(options.modulePath).href,
    );
  } catch (error: unknown) {
    throw new RuntimePluginConstructionError(
      `${options.subject} could not import the configured module at "${options.modulePath}"; check that the file exists and loads on its own.`,
      {cause: error},
    );
  }
}
