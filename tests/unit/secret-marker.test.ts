import {describe, expect, it} from 'vitest';

import {
  nestedSecretMarkerPath,
  valueIsSecretMarker,
} from '../../src/shared/secret-marker.ts';

describe('valueIsSecretMarker', () => {
  it('detects env refs and plaintext markers regardless of value type', () => {
    expect(valueIsSecretMarker({$env: 'API_KEY'})).toBe(true);
    expect(valueIsSecretMarker({$env: 123})).toBe(true);
    expect(
      valueIsSecretMarker({
        $plaintextSecret: 'x',
        allowPlaintextSecret: true,
        justification: 'test',
      }),
    ).toBe(true);
    expect(valueIsSecretMarker({$plaintextSecret: null})).toBe(true);
  });

  it('leaves plain values, arrays, and marker-free objects alone', () => {
    expect(valueIsSecretMarker('$env')).toBe(false);
    expect(valueIsSecretMarker(null)).toBe(false);
    expect(valueIsSecretMarker([{$env: 'X'}])).toBe(false);
    expect(valueIsSecretMarker({env: 'X'})).toBe(false);
  });
});

describe('nestedSecretMarkerPath', () => {
  it('names the marker itself at the base path', () => {
    expect(nestedSecretMarkerPath({$env: 'X'}, 'field')).toBe('field');
  });

  it('names nested object positions with dot paths', () => {
    expect(nestedSecretMarkerPath({outer: {inner: {$env: 'X'}}}, 'field')).toBe(
      'field.outer.inner',
    );
  });

  it('names array entries with the canonical bracket format', () => {
    expect(
      nestedSecretMarkerPath({list: [{ok: true}, {$env: 'X'}]}, 'field'),
    ).toBe('field.list[1]');
  });

  it('flags malformed markers exactly like well-formed ones', () => {
    expect(nestedSecretMarkerPath({nested: {$env: 123}}, 'field')).toBe(
      'field.nested',
    );
  });

  it('walks object keys in sorted order for a deterministic first hit', () => {
    expect(
      nestedSecretMarkerPath({zebra: {$env: 'Z'}, alpha: {$env: 'A'}}, 'field'),
    ).toBe('field.alpha');
  });

  it('optionally rejects plaintext allowance markers', () => {
    const value = {
      nested: {
        allowPlaintextSecret: false,
      },
    };

    expect(nestedSecretMarkerPath(value, 'field')).toBeUndefined();
    expect(
      nestedSecretMarkerPath(value, 'field', {
        rejectPlaintextAllowanceMarker: true,
      }),
    ).toBe('field.nested');
  });

  it('returns undefined for marker-free structures', () => {
    expect(
      nestedSecretMarkerPath({list: [1, 'two', null], flag: true}, 'field'),
    ).toBeUndefined();
    expect(nestedSecretMarkerPath('plain', 'field')).toBeUndefined();
  });
});
