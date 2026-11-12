/**
 * The chat follows its newest line. While it does, whatever changes at the
 * thread's end — a line arriving, her reply growing as she writes it, the
 * dock above the message box opening or closing — keeps that end in view
 * frame by frame, and a change of the thread's own eases in at the pace
 * and by the curve of the dock's closing (styles.css), so a line that
 * arrives as the dock closes settles with it in one motion and nothing
 * jumps. A page of history landing is no such change: the chat goes to its
 * end at once. Only a scroll of the person's stops it following, by leaving
 * the end, where one the page makes itself, or the browser makes to keep
 * its place, says nothing; whatever scroll comes back to the end starts it
 * again. Browser-only: the browser suite is its cover.
 */
import {useLayoutEffect, useRef, type RefObject} from 'react';

/** How long after the person's own wheel, touch, press or key a scroll is theirs. */
const theirsFor = 800;

/** How near its end a scroll leaves the chat following it. */
const nearEnd = 6;

/** The keys that scroll what has the page's attention, outside a box being typed in. */
const scrollKeys = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

/** The scroller, the lines in it, and the room it keeps under them while a shrinking end eases in. */
export type Following = {
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly lines: RefObject<HTMLDivElement | null>;
  readonly slack: RefObject<HTMLDivElement | null>;
};

type Follower = {
  /** After a render, `page` naming the history pages read so far: what changed at the end eases in, and a page landing is gone to. */
  readonly rendered: (page: string) => void;
  readonly stop: () => void;
};

/** An easing of the thread's end from `from` pixels to none, on the document's timeline. */
type Ease = {
  readonly from: number;
  readonly progress: () => number;
  readonly done: () => boolean;
  readonly cancel: () => void;
};

/**
 * Follows the chat's newest line, `page` naming the pages of its history
 * read so far: when it changes, a page landed.
 */
export function useFollowing(page: string): Following {
  const scroller = useRef<HTMLDivElement>(null);
  const lines = useRef<HTMLDivElement>(null);
  const slack = useRef<HTMLDivElement>(null);
  const follower = useRef<Follower>(undefined);

  useLayoutEffect(() => {
    if (
      scroller.current === null ||
      lines.current === null ||
      slack.current === null
    ) {
      return undefined;
    }

    const made = createFollower(scroller.current, lines.current, slack.current);

    follower.current = made;

    return () => {
      made.stop();
      follower.current = undefined;
    };
  }, []);

  useLayoutEffect(() => {
    follower.current?.rendered(page);
  });

  return {scroller, lines, slack};
}

function createFollower(
  scroller: HTMLElement,
  lines: HTMLElement,
  slack: HTMLElement,
): Follower {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const easeFrom = closingEase();
  let following = true;
  /** When the person last touched the chat: a wheel, a touch, a press or a key. */
  let theirs = -Infinity;
  let pressing = false;
  /** Where the page last scrolled it: a scroll that finds it there is the page's own. */
  let own = Number.NaN;
  let height = heightOf(lines);
  let lastPage: string | undefined;
  let ease: Ease | undefined;
  let frame = 0;

  /** What of the end is still below the view, or under nought the room still kept for what left it. */
  const offset = (): number =>
    ease === undefined ? 0 : ease.from * (1 - ease.progress());
  const pin = (): void => {
    if (!following) {
      return;
    }

    const left = offset();

    slack.style.height = left < 0 ? `${String(-left)}px` : '';
    scroller.scrollTop =
      scroller.scrollHeight - scroller.clientHeight - Math.max(0, left);
    own = scroller.scrollTop;
  };
  const step = (): void => {
    frame = 0;

    if (ease?.done() === true) {
      ease = undefined;
    }

    pin();

    if (ease !== undefined) {
      frame = requestAnimationFrame(step);
    }
  };
  const settle = (): void => {
    ease?.cancel();
    ease = undefined;
    slack.style.height = '';
  };
  /** The lines' end moved by `delta` pixels: eased in from where it was, or gone to at once. */
  const moved = (delta: number, eased: boolean): void => {
    if (delta === 0 || !following) {
      return;
    }

    if (eased && !reduced.matches) {
      const from = offset() + delta;

      ease?.cancel();
      ease = easeFrom(from);
      frame = frame === 0 ? requestAnimationFrame(step) : frame;
    } else {
      settle();
    }

    pin();
  };
  /**
   * A scroll that comes to the end starts the chat following again, the
   * tail of a flick the person let go of among them; only one of the
   * person's that leaves the end stops it.
   */
  const scrolled = (): void => {
    const top = scroller.scrollTop;

    if (Math.abs(top - own) < 1) {
      return;
    }

    if (scroller.scrollHeight - top - scroller.clientHeight <= nearEnd) {
      following = true;
    } else if (pressing || performance.now() - theirs <= theirsFor) {
      following = false;
      settle();
    }
  };
  const touched = (): void => {
    theirs = performance.now();
  };
  const pressed = (): void => {
    pressing = true;
    touched();
  };
  const released = (): void => {
    if (pressing) {
      pressing = false;
      touched();
    }
  };
  const keyed = (event: KeyboardEvent): void => {
    if (scrollKeys.has(event.key) && !typedIn(event.target)) {
      touched();
    }
  };
  const resized = new ResizeObserver(pin);
  // A change the page did not render, as text wrapping anew in a window
  // made narrower: gone to at once.
  const regrown = new ResizeObserver(() => {
    const now = heightOf(lines);
    const delta = now - height;

    height = now;
    moved(delta, false);
  });

  scroller.addEventListener('scroll', scrolled, {passive: true});
  scroller.addEventListener('wheel', touched, {passive: true});
  scroller.addEventListener('touchmove', touched, {passive: true});
  scroller.addEventListener('pointerdown', pressed);
  window.addEventListener('pointerup', released);
  window.addEventListener('pointercancel', released);
  document.addEventListener('keydown', keyed);
  resized.observe(scroller);
  regrown.observe(lines);
  pin();

  return {
    rendered(page) {
      const now = heightOf(lines);
      const delta = now - height;
      const landed = lastPage !== undefined && page !== lastPage;

      height = now;
      lastPage = page;
      moved(delta, !landed);
    },
    stop() {
      scroller.removeEventListener('scroll', scrolled);
      scroller.removeEventListener('wheel', touched);
      scroller.removeEventListener('touchmove', touched);
      scroller.removeEventListener('pointerdown', pressed);
      window.removeEventListener('pointerup', released);
      window.removeEventListener('pointercancel', released);
      document.removeEventListener('keydown', keyed);
      resized.disconnect();
      regrown.disconnect();
      cancelAnimationFrame(frame);
      ease?.cancel();
    },
  };
}

/**
 * The dock's closing as styles.css times it, `--close-time` by
 * `--close-curve`, as an easing on the document's timeline: begun in a
 * render, it starts with the frame that starts the dock's own.
 */
function closingEase(): (from: number) => Ease {
  const style = getComputedStyle(document.documentElement);
  const duration = millisecondsOf(style.getPropertyValue('--close-time'));
  const easing = style.getPropertyValue('--close-curve').trim();

  return from => {
    const effect = new KeyframeEffect(null, null, {
      duration,
      easing,
      fill: 'forwards',
    });
    const animation = new Animation(effect, document.timeline);

    animation.play();

    return {
      from,
      progress: () => effect.getComputedTiming().progress ?? 1,
      done: () => animation.playState === 'finished',
      cancel: () => {
        animation.cancel();
      },
    };
  };
}

/** An element's height to the fraction of a pixel, as lines of text have it. */
function heightOf(element: HTMLElement): number {
  return element.getBoundingClientRect().height;
}

/** A CSS time in milliseconds, as the built style sheet writes it: `280ms`, or `.28s`. */
function millisecondsOf(time: string): number {
  const value = Number.parseFloat(time);

  return time.trim().endsWith('ms') ? value : value * 1000;
}

/** Whether a key goes to a box being typed in, where it moves the caret, not the chat. */
function typedIn(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}
