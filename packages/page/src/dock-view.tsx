/**
 * The bottom of the main column, one surface: the message box, and above
 * it the dock, which opens while something waits for the person's answer
 * and holds the card that asks, moved as the approved prototype moves it.
 * The dock's height is what moves the chat: it opens to the card's height
 * as the card fades and rises in, and closes a little quicker once the
 * card has said how its ask ended; when the next takes the spot, the
 * answered card leaves upward as the next rises into its place and the
 * dock keeps its height. Which card is in front and when it gives way is
 * dock.ts's; here are the cards and their motion, which styles.css drops
 * for a person who asked for less.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';

import type {Answer} from '@project02/wire/contract';
import {
  confirmationWords,
  pairingWords,
  timeLeft,
  type AskWords,
} from './ask-words.ts';
import {
  askKey,
  edgesOf,
  expiryOf,
  frontOf,
  type Answered,
  type Ask,
  type Front,
} from './dock.ts';
import {avatarColor, initialOf} from './look.ts';
import type {Session} from './session.ts';
import {Icon} from './settings-controls.tsx';
import {characterName, type WebState} from './store.ts';
import {Composer} from './thread.tsx';

/** How long an answered card says so before the next takes the spot, as the prototype times it. */
const answerShows = 520;

/** How long after that an answered card keeps its room for her, at most, with nothing else waiting. */
const answerWaits = 2600;

/** How long a card takes to leave: upward for the next, or down with the dock. */
const leavesIn = {out: 240, closing: 300} as const;

/** How long a card in the spot takes no click: one meant for the card it replaced never answers it. */
const settlesIn = 250;

/** The cards the dock shows: the one in front, and those on their way out, each as it last showed. */
type Stack = {
  readonly front?: Front;
  readonly leaving: readonly Leaving[];
};

type Leaving = Front & {readonly how: keyof typeof leavesIn};

/**
 * The bottom surface: the dock, over the message box while a chat is
 * open. With no chat open the dock is at the bottom all the same, and the
 * surface shows nothing while it holds nothing.
 */
export function Bottom({
  state,
  session,
}: {
  readonly state: WebState;
  readonly session: Session;
}) {
  const {thread} = state;
  const front = frontOf(state);
  const [stack, gone] = useStack(front);
  const reduced = useReducedMotion();
  const dock = useRef<HTMLDivElement>(null);
  const pad = useRef<HTMLDivElement>(null);
  const open = front !== undefined;
  const cards: readonly (Front & {readonly how?: Leaving['how']})[] = [
    ...stack.leaving,
    ...(stack.front === undefined ? [] : [stack.front]),
  ];

  useAnsweredMoments(state, session, reduced);
  useDockHeight(dock, pad, open);

  return (
    <div className={bottomClasses(thread === undefined, cards.length === 0)}>
      <div
        ref={dock}
        className={`dock${open ? '' : ' dock-closing'}`}
        data-edges={edgesOf(state)}
      >
        <div ref={pad} className="dock-pad">
          <span className="dock-edge dock-edge-far" />
          <span className="dock-edge dock-edge-near" />
          <div className="dock-slot">
            {cards.map(card => (
              <AskCard
                key={askKey(card.ask)}
                front={card}
                words={wordsOf(state, card.ask)}
                session={session}
                {...(card.how === undefined ? {} : {leaving: card.how})}
                onGone={gone}
              />
            ))}
          </div>
        </div>
      </div>
      {thread === undefined ? null : (
        // Keyed by the thread, as the thread is: the box of another
        // character's chat is ready to type in.
        <Composer
          key={thread.conversationId}
          state={state}
          thread={thread}
          session={session}
        />
      )}
    </div>
  );
}

/** The surface without a message box when no chat is open, and without its edge while it shows nothing then. */
function bottomClasses(alone: boolean, empty: boolean): string {
  return [
    'bottom',
    ...(alone ? ['bottom-alone'] : []),
    ...(alone && empty ? ['bottom-bare'] : []),
  ].join(' ');
}

/**
 * The cards as the dock's front moves: a card that gives way leaves,
 * upward for a next one or down with the dock, each as it last showed,
 * and one closing with the dock makes way for a next. A card that left is
 * let go once it is gone.
 */
function useStack(
  front: Front | undefined,
): readonly [Stack, (key: string) => void] {
  const [stack, setStack] = useState<Stack>(() => stackOf(front, []));
  const gone = useCallback((key: string) => {
    setStack(current => ({
      ...current,
      leaving: current.leaving.filter(card => askKey(card.ask) !== key),
    }));
  }, []);

  if (shownAs(front) !== shownAs(stack.front)) {
    setStack(restacked(stack, front));
  }

  return [stack, gone];
}

/** The stack once the dock's front is `front`. */
function restacked(stack: Stack, front: Front | undefined): Stack {
  const before = stack.front;
  const leaving: readonly Leaving[] =
    before === undefined ||
    (front !== undefined && askKey(before.ask) === askKey(front.ask))
      ? stack.leaving
      : [
          ...stack.leaving,
          {...before, how: front === undefined ? 'closing' : 'out'},
        ];

  return stackOf(
    front,
    front === undefined
      ? leaving
      : leaving.map(card => ({...card, how: 'out'})),
  );
}

function stackOf(front: Front | undefined, leaving: readonly Leaving[]): Stack {
  return {...(front === undefined ? {} : {front}), leaving};
}

/** A front as the card shows it: which ask, and how it ended once it has. */
function shownAs(front: Front | undefined): string {
  return front === undefined
    ? ''
    : `${askKey(front.ask)} ${front.answered ?? ''}`;
}

/**
 * The dock is as tall as what it holds while it is open, and nothing once
 * it closes; a card that wraps anew, or opens its Details, is followed.
 */
function useDockHeight(
  dock: RefObject<HTMLDivElement | null>,
  pad: RefObject<HTMLDivElement | null>,
  open: boolean,
): void {
  const opened = useRef(open);

  useLayoutEffect(() => {
    opened.current = open;
    sized(dock.current, pad.current, open);
  });

  useLayoutEffect(() => {
    if (pad.current === null) {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      sized(dock.current, pad.current, opened.current);
    });

    observer.observe(pad.current);

    return () => {
      observer.disconnect();
    };
  }, [dock, pad]);
}

function sized(
  dock: HTMLElement | null,
  pad: HTMLElement | null,
  open: boolean,
): void {
  if (dock !== null && pad !== null) {
    dock.style.height = open
      ? `${String(pad.getBoundingClientRect().height)}px`
      : '0px';
  }
}

/**
 * The moments of an ask that ended in front: half a second to say how
 * (at once for a person who asked for less motion), and then, with
 * nothing else waiting, the wait before its room is given up.
 */
function useAnsweredMoments(
  state: WebState,
  session: Session,
  reduced: boolean,
): void {
  const {held} = state;
  const key = held === undefined ? undefined : askKey(held.ask);
  const lingering = held?.lingering === true;

  useEffect(() => {
    if (key === undefined) {
      return undefined;
    }

    const moment = lingering
      ? setTimeout(() => {
          session.dockWaited(key);
        }, answerWaits)
      : setTimeout(
          () => {
            session.dockStepped(key);
          },
          reduced ? 0 : answerShows,
        );

    return () => {
      clearTimeout(moment);
    };
  }, [key, lingering, reduced, session]);
}

/**
 * The card that asks: the tile of what it is about, with the picture of
 * who asks on its corner; a title and a sentence; at its end, small, where
 * it was asked and the time left, then Don't Allow and Allow, which answer
 * it, and once it ended, how. A card leaving takes nothing in.
 */
function AskCard({
  front,
  words,
  session,
  leaving,
  onGone,
}: {
  readonly front: Front;
  readonly words: AskWords;
  readonly session: Session;
  readonly leaving?: Leaving['how'];
  readonly onGone: (key: string) => void;
}) {
  const {ask, answered} = front;
  const key = askKey(ask);
  const id = useId();
  const card = useRef<HTMLDivElement>(null);
  const shownAt = useRef(Number.POSITIVE_INFINITY);
  const [arrived, setArrived] = useState(false);
  const [answering, setAnswering] = useState<Answer>();
  const settled = answered !== undefined;
  const resting = answering !== undefined || settled;

  // Drawn first where it starts, then moved in, so its arrival is drawn from there.
  useLayoutEffect(() => {
    card.current?.getBoundingClientRect();
    shownAt.current = performance.now();
    setArrived(true);
  }, []);

  // Answered from the keyboard, the person writes on: the message box
  // takes the focus from the buttons that just went.
  useLayoutEffect(() => {
    const element = card.current;

    if (settled && element?.contains(document.activeElement) === true) {
      element
        .closest('.bottom')
        ?.querySelector<HTMLElement>('.composer input')
        ?.focus();
    }
  }, [settled]);

  useEffect(() => {
    if (leaving === undefined) {
      return undefined;
    }

    const timer = setTimeout(() => {
      onGone(key);
    }, leavesIn[leaving]);

    return () => {
      clearTimeout(timer);
    };
  }, [key, leaving, onGone]);

  const answer = (decision: Answer): void => {
    if (
      resting ||
      leaving !== undefined ||
      performance.now() - shownAt.current < settlesIn
    ) {
      return;
    }

    setAnswering(decision);
    void sendAnswer(session, ask, decision).then(taken => {
      // One the daemon took is settled by the stream; one it did not is
      // the person's to answer again.
      if (!taken) {
        setAnswering(undefined);
      }
    });
  };

  return (
    <div
      ref={card}
      role="group"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-sentence`}
      aria-hidden={leaving === undefined ? undefined : true}
      inert={leaving !== undefined}
      className={cardClasses(arrived, leaving, settled)}
    >
      <span
        className={`ask-tile tile-solid tint-${words.tile.tint}`}
        aria-hidden="true"
      >
        <Icon name={words.tile.icon} size={22} weight={1.7} />
        {words.asker === undefined ? null : (
          <span
            className="ask-badge"
            style={{background: avatarColor(words.asker.id)}}
          >
            {initialOf(words.asker.name)}
          </span>
        )}
      </span>
      <div className="ask-words">
        <strong id={`${id}-title`} className="ask-title">
          {words.title}
        </strong>
        <span id={`${id}-sentence`} className="ask-sentence">
          {words.sentence}
        </span>
        {words.details === undefined ? null : (
          <details className="ask-details">
            <summary>Details</summary>
            <pre>{words.details}</pre>
          </details>
        )}
      </div>
      <div className="ask-end">
        <span className="ask-meta" aria-hidden={settled ? true : undefined}>
          <Icon name="clock" size={12} weight={2} />
          <span aria-hidden="true">
            {words.where === undefined ? null : `${words.where} · `}
            <TimeLeft at={expiryOf(ask)} />
          </span>
          <span className="visually-hidden">
            {`${words.where === undefined ? '' : `${words.where}. `}Expires at ${clockTime(expiryOf(ask))}.`}
          </span>
        </span>
        <span className="ask-choices">
          <button
            type="button"
            className={`ask-button${answering === 'denied' ? ' ask-pressed' : ''}`}
            aria-disabled={resting}
            onClick={() => {
              answer('denied');
            }}
          >
            Don't Allow
          </button>
          <button
            type="button"
            className={`ask-button ask-allow${answering === 'approved' ? ' ask-pressed' : ''}`}
            aria-disabled={resting}
            onClick={() => {
              answer('approved');
            }}
          >
            Allow
          </button>
        </span>
        <span
          className={`ask-said${answered === 'allowed' ? ' ask-said-yes' : ''}`}
          aria-live="polite"
        >
          {answered === undefined ? null : <Said answered={answered} />}
        </span>
      </div>
    </div>
  );
}

function cardClasses(
  arrived: boolean,
  leaving: Leaving['how'] | undefined,
  settled: boolean,
): string {
  return [
    'ask',
    ...(arrived && leaving !== 'closing' ? ['ask-in'] : []),
    ...(leaving === 'out' ? ['ask-out'] : []),
    ...(settled ? ['ask-settled'] : []),
  ].join(' ');
}

/** How an ask ended, in place of its buttons. */
function Said({answered}: {readonly answered: Answered}) {
  switch (answered) {
    case 'allowed':
      return (
        <>
          <Icon name="check" size={16} weight={2.4} />
          Allowed
        </>
      );
    case 'not_allowed':
      return <>Not allowed</>;
    case 'expired':
      return <>Expired</>;
  }
}

/** The time an ask has left, counted down on each second. */
function TimeLeft({at}: {readonly at: number}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const left = at - now;

    if (left <= 0) {
      return undefined;
    }

    // The next second shown begins when what is left crosses a whole one.
    const tick = setTimeout(
      () => {
        setNow(Date.now());
      },
      left % 1000 || 1000,
    );

    return () => {
      clearTimeout(tick);
    };
  }, [at, now]);

  return <>{timeLeft(at, now)}</>;
}

/** The person's answer to an ask, by the verb its kind takes: whether the daemon took it. */
function sendAnswer(
  session: Session,
  ask: Ask,
  decision: Answer,
): Promise<boolean> {
  return ask.kind === 'confirmation'
    ? session.answer(ask.pending.id, decision)
    : session.settlePairing(ask.request.code, decision);
}

/** What an ask says: her name and her settings for one of hers, a pairing's own words for someone new. */
function wordsOf(state: WebState, ask: Ask): AskWords {
  if (ask.kind === 'pairing') {
    return pairingWords(ask.request);
  }

  const {characterId} = ask.pending;

  return confirmationWords(
    ask.pending,
    characterName(state, characterId),
    state.herSettings.get(characterId),
  );
}

/** The hour and minute an ask expires at, on the person's clock. */
function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Whether the person asked their system for less motion, as it says now. */
function useReducedMotion(): boolean {
  const reduced = useMemo(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');

    return {
      subscribe: (listener: () => void) => {
        query.addEventListener('change', listener);

        return () => {
          query.removeEventListener('change', listener);
        };
      },
      matches: () => query.matches,
    };
  }, []);

  return useSyncExternalStore(reduced.subscribe, reduced.matches);
}
