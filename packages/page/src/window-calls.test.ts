import {describe, expect, it} from 'vitest';

import {findWindowCalls, inTheApp, notifierOf} from './window-calls.ts';

/**
 * A page in a window of the desktop app, as Tauri sets it up: every call
 * the page makes is kept, and answered as `answers` has it by the call's
 * name, or refused, as the app refuses a page it does not let call, where
 * `answers` is an error.
 */
function appPage(answers: Readonly<Record<string, unknown>> | Error) {
  const asked: unknown[] = [];
  const page = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args?: unknown) => {
        asked.push(args === undefined ? command : [command, args]);

        return answers instanceof Error
          ? Promise.reject(answers)
          : Promise.resolve(answers[command] ?? null);
      },
    },
  };

  return {page, asked};
}

describe('the window a page is drawn in', () => {
  it("is the desktop app's, and its calls reach the window where it answers them: whether it stays on top, then moving it, keeping it on top, closing it", async () => {
    const {page, asked} = appPage({'plugin:window|is_always_on_top': true});
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

  it("has the app show a notification, asking the system's permission once, the first time it has one to show", async () => {
    const {page, asked} = appPage({
      'plugin:notification|request_permission': 'granted',
    });
    const notify = notifierOf(page);

    expect(asked).toEqual([]);

    await notify?.({title: 'Mira', body: 'I found the tea you like.'});
    await notify?.({title: 'Mira', body: 'Still up?'});

    expect(asked).toEqual([
      'plugin:notification|request_permission',
      [
        'plugin:notification|notify',
        {options: {title: 'Mira', body: 'I found the tea you like.'}},
      ],
      [
        'plugin:notification|notify',
        {options: {title: 'Mira', body: 'Still up?'}},
      ],
    ]);
  });

  it("shows no notification once the system says no, or where the app does not let the window ask, and asks no more; a browser's page has none to show", async () => {
    for (const answers of [
      {'plugin:notification|request_permission': 'denied'},
      new Error(
        'Command plugin:notification|request_permission not allowed by ACL',
      ),
    ]) {
      const {page, asked} = appPage(answers);
      const notify = notifierOf(page);

      await notify?.({title: 'Mira', body: 'I found the tea you like.'});
      await notify?.({title: 'Mira', body: 'Still up?'});

      expect(asked).toEqual(['plugin:notification|request_permission']);
    }

    expect(notifierOf({})).toBeUndefined();
  });
});
