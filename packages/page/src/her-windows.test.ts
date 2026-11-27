import {describe, expect, it} from 'vitest';

import {
  framed,
  hasWindow,
  noWindows,
  windowAnswered,
  windowGone,
  windowShows,
  type Frame,
} from './her-windows.ts';

describe('the windows of hers', () => {
  it('presses the button of a window of hers while that window says it shows hers, whichever page of a window taken over speaks last, and gives her chat the button only once the daemon says she has what it shows: her phone, or her world', () => {
    let state = windowShows(noWindows, 'phone', 'mira');

    expect(state.windowShows.get('phone')).toBe('mira');

    state = windowShows(windowShows(state, 'phone', 'nova'), 'world', 'mira');

    expect(windowGone(state, 'phone', 'mira')).toBe(state);
    expect(windowGone(state, 'phone', 'nova').windowShows).toEqual(
      new Map([['world', 'mira']]),
    );

    const noWorld = {
      status: 'refused',
      reason: 'no_world',
      message: 'Nova has no world.',
    } as const;
    const worlds = windowAnswered(
      windowAnswered(noWindows, 'world', 'mira', {
        status: 'failed',
        message: 'Her world could not be read.',
      }),
      'world',
      'nova',
      noWorld,
    );

    expect([
      hasWindow(noWindows, 'world', 'mira'),
      hasWindow(worlds, 'world', 'mira'),
      hasWindow(worlds, 'world', 'nova'),
      hasWindow(worlds, 'phone', 'mira'),
    ]).toEqual([false, true, false, false]);
    expect(windowAnswered(worlds, 'world', 'nova', noWorld)).toBe(worlds);
    expect(
      hasWindow(
        windowAnswered(worlds, 'world', 'mira', noWorld),
        'world',
        'mira',
      ),
    ).toBe(false);
  });

  it('draws the frame of a window that has none of its own, its pin pressed while the window stays on top, and none for a window with a frame of its own', () => {
    const popup: {readonly frame?: Frame} = {};
    const pinned = framed(popup, true);

    expect(pinned.frame).toEqual({pinned: true});
    expect(framed(pinned, true)).toBe(pinned);
    expect(framed(pinned, false).frame).toEqual({pinned: false});
  });
});
