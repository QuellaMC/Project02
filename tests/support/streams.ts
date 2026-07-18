import {Writable} from 'node:stream';

/**
 * Creates a writable sink that forwards each chunk to `write` as a UTF-8
 * string. The stdout/stderr capture primitive for CLI-driving tests.
 */
export function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      callback();
    },
  });
}
