import { writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';

import { runtimeConfigVersion } from '../../src/runtime/config/index.ts';

export function writeRuntimeConfig(
  path: string,
  config: Readonly<Record<string, unknown>>
): string {
  const {
    storeRoot,
    defaultMemoryProvider,
    roleModelProvider,
    project02,
    ...rest
  } = config;
  const project02Config =
    project02 ??
    (storeRoot === undefined &&
    defaultMemoryProvider === undefined &&
    roleModelProvider === undefined
      ? undefined
      : {
          ...(storeRoot === undefined ? {} : { storeRoot }),
          ...(defaultMemoryProvider === undefined
            ? {}
            : { defaultMemoryProvider }),
          ...(roleModelProvider === undefined ? {} : { roleModelProvider })
        });

  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: runtimeConfigVersion,
        ...(project02Config === undefined ? {} : { project02: project02Config }),
        ...rest
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  return path;
}

export function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      callback();
    }
  });
}
