import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

export default function createProvider({dataDir}) {
  return {
    prefetch() {
      return {items: []};
    },
    search() {
      return [];
    },
    shutdown() {
      writeFileSync(join(dataDir, 'shutdown.marker'), 'released');
    },
  };
}
