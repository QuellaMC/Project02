import {describe, expect, it} from 'vitest';

import {findWindowCalls, inTheApp} from './window-calls.ts';

/**
 * A page in a window of the desktop app, as Tauri sets it up: every call
 * the page makes is kept, and the window says it stays on top of others or
 * not, or refuses the page, as `onTop` has it.
 */
function appPage(onTop: boolean | Error) {
  const asked: unknown[] = [];
  const page = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: unknown) => {
        asked.push(args === undefined ? command : [command, args]);

        if (onTop instanceof Error) {
          return Promise.reject(onTop);
        }

        return Promise.resolve(
          command === 'plugin:window|is_always_on_top' ? onTop : null,
        );
      },
    },
  };

  return {page, asked};
}

describe('the window a page is drawn in', () => {
  it("is the desktop app's, and its calls reach the window where it answers them: whether it stays on top, then moving it, keeping it on top, closing it", async () => {
    const {page, asked} = appPage(true);
    const calls = await findWindowCalls(page);

    expect(inTheApp(page)).toBe(true);
    expect(calls?.pinned).toBe(true);

    await calls?.startDragging();
    await calls?.pin(false);
    await calls?.close();

    expect(asked).toEqual([
      'plugin:window|is_always_on_top',
      'plugin:window|start_dragging',
      ['plugin:window|set_always_on_top', {value: false}],
      'plugin:window|close',
    ]);
  });

  it("is a browser's, with no calls; and the app's without them, where the app refuses this page", async () => {
    const refusing = appPage(
      new Error('Command plugin:window|is_always_on_top not allowed by ACL'),
    ).page;

    expect(inTheApp({})).toBe(false);
    expect(await findWindowCalls({})).toBeUndefined();
    expect(inTheApp(refusing)).toBe(true);
    expect(await findWindowCalls(refusing)).toBeUndefined();
  });
});
