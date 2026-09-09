import {describe, expect, it} from 'vitest';
import {optionalRoleModelProviderMetadataOption} from '../../src/runtime/storage/provider-metadata-codec.ts';

describe('provider metadata codec', () => {
  it('reads a request block written before replies streamed, stream flag and all, as one written now', () => {
    const before = optionalRoleModelProviderMetadataOption({
      provider: 'nvidia',
      model: 'nvidia/test-model',
      request: {
        endpoint: 'https://example.test',
        messageCount: 3,
        stream: false,
      },
      response: {status: 200},
    });
    const now = optionalRoleModelProviderMetadataOption({
      provider: 'nvidia',
      model: 'nvidia/test-model',
      request: {endpoint: 'https://example.test', messageCount: 3},
      response: {status: 200},
    });

    expect(before).toEqual(now);
    expect(now.providerMetadata?.request).toEqual({
      endpoint: 'https://example.test',
      messageCount: 3,
    });
  });
});
