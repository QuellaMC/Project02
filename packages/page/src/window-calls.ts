/**
 * The desktop app, as far as a page in it can see: Tauri puts its `invoke`
 * on the `window` of every page the app draws, and lets each window call
 * through it only what the app gives that window. Her phone's window
 * answers four window calls: whether the window stays on top of other
 * windows, keeping it so, moving it with the pointer, and closing it. The
 * main window shows a notification, once the system allows it. A browser
 * has none of it. The page imports nothing of Tauri: it asks its `window`,
 * and does without.
 */

/** How Tauri lets a page reach the app: a command by its name, with its arguments. */
type Invoke = (
  command: string,
  args?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

/** The window's calls, and whether it stayed on top of others when they were found. */
export type WindowCalls = {
  readonly pinned: boolean;
  readonly startDragging: () => Promise<void>;
  readonly pin: (pinned: boolean) => Promise<void>;
  readonly close: () => Promise<void>;
};

/** What the desktop app shows as a notification: a title, and a body under it. */
export type DesktopNotification = {
  readonly title: string;
  readonly body: string;
};

/** Whether `page` is drawn by the desktop app, whatever its window may call. */
export function inTheApp(page: object): boolean {
  return invokeOf(page) !== undefined;
}

/**
 * The calls of the window `page` runs in, found once that window said
 * whether it stays on top of others; none where it answers no call, or
 * refuses this page.
 */
export async function findWindowCalls(
  page: object,
): Promise<WindowCalls | undefined> {
  const invoke = invokeOf(page);

  if (invoke === undefined) {
    return undefined;
  }

  const pinned = await invoke('plugin:window|is_always_on_top').catch(
    () => undefined,
  );

  return typeof pinned === 'boolean'
    ? {
        pinned,
        startDragging: async () => {
          await invoke('plugin:window|start_dragging');
        },
        pin: async value => {
          await invoke('plugin:window|set_always_on_top', {value});
        },
        close: async () => {
          await invoke('plugin:window|close');
        },
      }
    : undefined;
}

/**
 * How `page` has the desktop app show a notification, through Tauri's
 * notification plugin; none in a browser. The first one asks the system's
 * permission, once, and its answer stands for every one after it: a no,
 * or a window the app does not let ask, shows none and says nothing.
 */
export function notifierOf(
  page: object,
): ((notification: DesktopNotification) => Promise<void>) | undefined {
  const invoke = invokeOf(page);

  if (invoke === undefined) {
    return undefined;
  }

  let allowed: Promise<boolean> | undefined;

  return async notification => {
    allowed ??= invoke('plugin:notification|request_permission').then(
      answer => answer === 'granted',
      () => false,
    );

    if (await allowed) {
      await invoke('plugin:notification|notify', {options: notification});
    }
  };
}

function invokeOf(page: object): Invoke | undefined {
  const internals =
    '__TAURI_INTERNALS__' in page ? page.__TAURI_INTERNALS__ : undefined;

  return typeof internals === 'object' &&
    internals !== null &&
    'invoke' in internals &&
    isInvoke(internals.invoke)
    ? internals.invoke
    : undefined;
}

/** Tauri's `invoke`: that it is a function is all a page can see of it. */
function isInvoke(value: unknown): value is Invoke {
  return typeof value === 'function';
}
