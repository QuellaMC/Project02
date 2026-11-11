/**
 * How the chat and her phone's window reach each other without the
 * daemon. The chat opens her phone in one window, whoever's phone it is,
 * so opening another character's takes the same window. Over a channel of
 * the page's own origin, her phone's window says whose phone it shows
 * when it opens, when it is asked and when it goes, and the chat asks it,
 * and asks it to close: a chat that was reloaded, or another tab, knows as
 * much as the one that opened it. Browser-only: the browser suite is its
 * cover.
 */

/** The one window her phone opens in. */
const windowName = 'project02.phone';
/** Her phone's window at the design's size. */
const windowFeatures = 'popup,width=372,height=792';
/** One home's: the page's origin is its daemon's. */
const channelName = 'project02.phone';

/** What the chat and her phone's window say to each other. */
type Said =
  | {readonly kind: 'shows' | 'gone' | 'close'; readonly characterId: string}
  | {readonly kind: 'ask'};

/** What her phone's window says of itself, as the chat hears it. */
type PhoneWindowNews = {
  readonly shows: (characterId: string) => void;
  readonly gone: (characterId: string) => void;
};

/**
 * Her phone at `address`, the chat's own, in its one window at the
 * design's size: false when the browser would not open it.
 */
export function openHerPhone(address: string, characterId: string): boolean {
  const phone = new URL(address);

  phone.searchParams.set('phone', characterId);

  return window.open(phone.href, windowName, windowFeatures) !== null;
}

/**
 * The chat's side: what her phone's window says of itself goes to `news`,
 * and the window is asked at once, so a chat that starts while it is open
 * knows whose phone it shows. `close` asks the window showing her phone
 * to close.
 */
export function followHerPhone(news: PhoneWindowNews): {
  readonly close: (characterId: string) => void;
} {
  const channel = new BroadcastChannel(channelName);

  channel.onmessage = ({data}: MessageEvent<unknown>) => {
    const said = saidOf(data);

    if (said?.kind === 'shows') {
      news.shows(said.characterId);
    } else if (said?.kind === 'gone') {
      news.gone(said.characterId);
    }
  };
  say(channel, {kind: 'ask'});

  return {
    close: characterId => {
      say(channel, {kind: 'close', characterId});
    },
  };
}

/**
 * Her phone's window tells the chat of itself: whose phone it shows, now
 * and whenever it is asked, and that it went once the page goes, however
 * it goes; and it closes when the chat asks it to.
 */
export function tellTheChat(characterId: string): void {
  const channel = new BroadcastChannel(channelName);

  channel.onmessage = ({data}: MessageEvent<unknown>) => {
    const said = saidOf(data);

    if (said?.kind === 'ask') {
      say(channel, {kind: 'shows', characterId});
    } else if (said?.kind === 'close' && said.characterId === characterId) {
      window.close();
    }
  };
  addEventListener('pagehide', () => {
    say(channel, {kind: 'gone', characterId});
  });
  say(channel, {kind: 'shows', characterId});
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
    'characterId' in data &&
    typeof data.characterId === 'string'
    ? {kind, characterId: data.characterId}
    : undefined;
}
