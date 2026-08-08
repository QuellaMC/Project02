import {Writable} from 'node:stream';

export function collect(write: (chunk: string) => void): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      write(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      callback();
    },
  });
}
