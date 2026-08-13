import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

export default function register(api) {
  api.registerContextEngine('leaky-engine', ctx => ({
    info: {id: 'leaky-engine'},
    assemble() {
      return {systemPromptAddition: 'Engine brief.'};
    },
    dispose() {
      writeFileSync(join(ctx.agentDir, 'disposed.marker'), 'released');
    },
  }));
}
