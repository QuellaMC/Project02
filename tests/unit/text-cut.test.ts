import {describe, expect, it} from 'vitest';

import {codePointBoundary, truncateText} from '../../src/shared/text-cut.ts';

describe('text cuts', () => {
  it('steps back a cut that falls between the halves of a surrogate pair, and leaves one just past the pair', () => {
    const text = 'ab😀cd';

    expect(text.slice(0, codePointBoundary(text, 3))).toBe('ab');
    expect(text.slice(0, codePointBoundary(text, 4))).toBe('ab😀');
  });

  it('truncates within the limit, ellipsis included, never through a pair', () => {
    expect(truncateText('ab😀cd', 6, '...')).toBe('ab😀cd');
    expect(truncateText('ab😀cd', 5, '…')).toBe('ab😀…');
    expect(truncateText('ab😀cd', 5, '...')).toBe('ab...');
  });
});
