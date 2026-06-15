import { describe, expect, it } from 'vitest';

import {
  redactRuntimePluginText
} from '../src/plugins/types.ts';

describe('runtime plugin text redaction', () => {
  it('redacts JSON-shaped quoted secret keys', () => {
    const cases = [
      ['{"api_key":"super-secret"}', '{"api_key":"[redacted]"}'],
      ['"password": "open-sesame"', '"password": "[redacted]"'],
      ['{ "token" : "secret-token" }', '{ "token" : "[redacted]" }'],
      ["'secret': 'hidden-value'", "'secret': '[redacted]'"]
    ] as const;

    for (const [input, expected] of cases) {
      expect(redactRuntimePluginText(input)).toBe(expected);
    }
  });
});
