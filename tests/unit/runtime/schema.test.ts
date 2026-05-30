import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION } from '../../../src/runtime/schema.ts';

describe('TypeScript runtime schema baseline', () => {
  it('preserves the Python runtime schema version', () => {
    expect(SCHEMA_VERSION).toBe('0.1');
  });
});
