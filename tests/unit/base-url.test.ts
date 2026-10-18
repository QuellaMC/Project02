import {describe, expect, it} from 'vitest';

import {endpointUnder} from '../../src/shared/base-url.ts';

describe('a base URL', () => {
  it('names one endpoint under it whether it ends with a slash or not', () => {
    expect(endpointUnder('http://127.0.0.1:1234/v1', 'chat/completions')).toBe(
      'http://127.0.0.1:1234/v1/chat/completions',
    );
    expect(endpointUnder('http://127.0.0.1:1234/v1/', 'chat/completions')).toBe(
      'http://127.0.0.1:1234/v1/chat/completions',
    );
    expect(endpointUnder('https://api.mem0.ai/', 'v1/ping/')).toBe(
      'https://api.mem0.ai/v1/ping/',
    );
    expect(endpointUnder('http://localhost:8765', '')).toBe(
      'http://localhost:8765/',
    );
  });
});
