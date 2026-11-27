/**
 * How the chat and the windows of hers reach each other without the
 * daemon, and what the person does with such a window itself. The chat
 * opens her phone in one window and her world in another, whoever's they
 * are, so opening another character's takes the same window. Over a
 * channel of the page's own origin, a window of hers says whose phone or
 * world it shows when it opens, when it is asked and when it goes, and the
 * chat asks it, and asks it to close: a chat that was reloaded, or another
 * tab, knows as much as the one that opened it. Where a window of hers
 * answers the desktop app's calls it has no frame of its own, and the page
 * draws one: its bar moves the window, its pin keeps it on top of others,
 * and closing it is the app's. Elsewhere a page closes the window a script
 * opened. Browser-only: the browser suite is its cover.
 */
import type {HerWindow} from './her-windows.ts';
import {findWindowCalls, inTheApp, type WindowCalls} from './window-calls.ts';

/** Each window of hers at the design's width; both are as tall. */
const widths: Readonly<Record<HerWindow, number>> = {phone: 372, world: 420};
const height = 792;

/** One home's: the page's origin is its daemon's. */
const channelName = 'project02.windows';

/** What the chat and a window of hers say to each other. */
type Said =
  | {
      readonly kind: 'shows' | 'gone' | 'close';
      readonly herWindow: HerWindow;
      readonly characterId: string;
    }
  | {readonly kind: 'ask'};

/** What a window of hers says of itself, as the chat hears it. */
type WindowNews = {
  readonly shows: (herWindow: HerWindow, characterId: string) => void;
  readonly gone: (herWindow: HerWindow, characterId: string) => void;
};

/** What the person does with a window of hers itself. */
export type FrameVerbs = {
  /** Starts moving the window with the pointer, where the page draws its frame. */
  readonly startDragging: () => void;
  /** Keeps the window on top of other windows, or no longer. */
  readonly pin: (pinned: boolean) => void;
  /** Closes the window. */
  readonly close: () => void;
};

/**
 * Her phone or her world, `herWindow`, at `address`, the chat's own, which
 * names her by it as `?phone=` and `?world=`, in its one window at the
 * design's size: false when the browser would not open it. The desktop app
 * opens that window itself and gives the page none: there nothing is
 * refused, and should it fail, the button stays as it was.
 */
export function openHerWindow(
  herWindow: HerWindow,
  address: string,
  characterId: string,
): boolean {
  const opened = new URL(address);

  opened.searchParams.set(herWindow, characterId);

  return (
    window.open(
      opened.href,
      `project02.${herWindow}`,
      `popup,width=${String(widths[herWindow])},height=${String(height)}`,
    ) !== null || inTheApp(window)
  );
}

/**
 * The chat's side: what a window of hers says of itself goes to `news`,
 * and the windows are asked at once, so a chat that starts while one is
 * open knows whose phone or world it shows. `close` asks the window
 * showing what is hers to close.
 */
export function followHerWindows(news: WindowNews): {
  readonly close: (herWindow: HerWindow, characterId: string) => void;
} {
  const channel = new BroadcastChannel(channelName);

  channel.onmessage = ({data}: MessageEvent<unknown>) => {
    const said = saidOf(data);

    if (said?.kind === 'shows') {
      news.shows(said.herWindow, said.characterId);
    } else if (said?.kind === 'gone') {
      news.gone(said.herWindow, said.characterId);
    }
  };
  say(channel, {kind: 'ask'});

  return {
    close: (herWindow, characterId) => {
      say(channel, {kind: 'close', herWindow, characterId});
    },
  };
}

/**
 * A window of hers tells the chat of itself: whose phone or world it
 * shows, now and whenever it is asked, and that it went once the page
 * goes, however it goes; and it closes, with `close`, when the chat asks
 * it to.
 */
export function tellTheChat(
  herWindow: HerWindow,
  characterId: string,
  close: () => void,
): void {
  const channel = new BroadcastChannel(channelName);

  channel.onmessage = ({data}: MessageEvent<unknown>) => {
    const said = saidOf(data);

    if (said?.kind === 'ask') {
      say(channel, {kind: 'shows', herWindow, characterId});
    } else if (
      said?.kind === 'close' &&
      said.herWindow === herWindow &&
      said.characterId === characterId
    ) {
      close();
    }
  };
  addEventListener('pagehide', () => {
    say(channel, {kind: 'gone', herWindow, characterId});
  });
  say(channel, {kind: 'shows', herWindow, characterId});
}

/**
 * The frame of the window a page of hers is drawn in. Where the window
 * answers the desktop app's calls, `pinned` hears whether it stays on top
 * of others, once found and after each pin; a call the window refuses
 * changes nothing of it.
 */
export function frameOf(pinned: (pinned: boolean) => void): FrameVerbs {
  const found = findWindowCalls(window);
  let calls: WindowCalls | undefined;

  void found.then(answered => {
    calls = answered;

    if (answered !== undefined) {
      pinned(answered.pinned);
    }
  });

  return {
    startDragging() {
      void calls?.startDragging().catch(() => undefined);
    },
    pin(value) {
      void calls?.pin(value).then(
        () => {
          pinned(value);
        },
        () => undefined,
      );
    },
    // Once the window has said what it answers: a page closing a window
    // of the app itself would leave the window there without it.
    close() {
      void found
        .then(async answered => {
          if (answered === undefined) {
            window.close();
          } else {
            await answered.close();
          }
        })
        .catch(() => undefined);
    },
  };
}

function say(channel: BroadcastChannel, said: Said): void {
  channel.postMessage(said);
}

/** What another page said, read as such: anything else is let go. */
function saidOf(data: unknown): Said | undefined {
  if (typeof data !== 'object' || data === null || !('kind' in data)) {
    return undefined;
  }

  const {kind} = data;

  if (kind === 'ask') {
    return {kind};
  }

  return (kind === 'shows' || kind === 'gone' || kind === 'close') &&
    'herWindow' in data &&
    (data.herWindow === 'phone' || data.herWindow === 'world') &&
    'characterId' in data &&
    typeof data.characterId === 'string'
    ? {kind, herWindow: data.herWindow, characterId: data.characterId}
    : undefined;
}
