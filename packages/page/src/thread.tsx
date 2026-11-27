import type {CharacterSummary} from '@project02/wire/contract';
import {hasWindow, herWindows, type HerWindow} from './her-windows.ts';
import {avatarColor, initialOf, type IconName} from './look.ts';
import type {Session} from './session.ts';
import {Icon} from './settings-controls.tsx';
import {
  characterName,
  composerText,
  doingIn,
  type LineState,
  type Thread,
  type WebState,
} from './store.ts';
import {
  drawnOf,
  laidOut,
  type Divider,
  type Form,
  type Placement,
  type Status,
} from './thread-layout.ts';
import {useFollowing} from './thread-scroll.ts';

/** States a character rests in; one switched off and resting is off. */
const restingStates = new Set<CharacterSummary['state']>([
  'not_started',
  'stopped',
  'failed',
]);

/**
 * A character's state as its pill says it. One that is switched off and
 * not running says off instead; one still running or on its way down
 * says so, since that is what the person sees happening. While an ask of
 * hers waits, her row says she asks, in the warning's ink.
 */
export function StatePill({
  character,
  asking = false,
}: {
  readonly character: CharacterSummary;
  readonly asking?: boolean;
}) {
  if (asking) {
    return <span className="pill pill-asking">Asking you…</span>;
  }

  const off = !character.enabled && restingStates.has(character.state);

  return (
    <span className={`pill pill-${off ? 'off' : character.state}`}>
      {off ? 'off' : stateWords(character.state)}
    </span>
  );
}

/** A state in a person's words: one without a model is waiting, not failed. */
function stateWords(state: CharacterSummary['state']): string {
  return state === 'needs_model'
    ? 'Needs an AI model'
    : state.replace('_', ' ');
}

/** Her initial on her colour, as the settings window shows her. */
export function Avatar({
  id,
  name,
}: {
  readonly id: string;
  readonly name: string;
}) {
  return (
    <span
      className="avatar"
      style={{background: avatarColor(id)}}
      aria-hidden="true"
    >
      {initialOf(name)}
    </span>
  );
}

export function ThreadPane({
  state,
  thread,
  session,
}: {
  readonly state: WebState;
  readonly thread: Thread;
  readonly session: Session;
}) {
  const character = state.health?.characters.find(
    summary => summary.id === thread.characterId,
  );
  const name = characterName(state, thread.characterId);
  const pending = [...state.pending].filter(
    ([, line]) => line.conversationId === thread.conversationId,
  );
  const doing = doingIn(state, thread.conversationId);
  const {locale, timeZone} = Intl.DateTimeFormat().resolvedOptions();
  const laid = laidOut(
    {
      messages: [...(thread.stale ?? []), ...thread.messages],
      between: doing !== undefined,
      pending,
    },
    {now: Date.now(), locale, timeZone},
  );
  // Which pages of its history the thread has read: a page landing moves
  // its lines as a whole, where anything else changes only its end.
  const following = useFollowing(
    `${thread.stale === undefined ? 'read' : 'reading'} ${thread.earlier ?? ''}`,
    session.endInView,
  );

  return (
    <section className="thread">
      <header className="thread-header">
        <Avatar id={thread.characterId} name={name} />
        <h2 className="thread-name">{name}</h2>
        {character === undefined ? null : <StatePill character={character} />}
        <span className="thread-windows">
          {herWindows.map(herWindow =>
            hasWindow(state, herWindow, thread.characterId) ? (
              <HerWindowButton
                key={herWindow}
                herWindow={herWindow}
                pressed={
                  state.windowShows.get(herWindow) === thread.characterId
                }
                inUse={herWindow === 'phone' && doing === 'phoning'}
                onToggle={() => {
                  session.toggleWindow(herWindow, thread.characterId);
                }}
              />
            ) : null,
          )}
        </span>
      </header>
      {thread.unread === undefined ? null : (
        <p className="notice" role="status">
          {thread.unread}
        </p>
      )}
      <div className="messages" ref={following.scroller}>
        <div className="lines" ref={following.lines}>
          {thread.earlier === undefined ? null : (
            <button
              type="button"
              className="load-earlier"
              onClick={() => {
                void session.loadEarlier();
              }}
            >
              Load earlier
            </button>
          )}
          {laid.messages.map(placed => (
            <Bubble
              key={placed.message.messageId}
              own={placed.own}
              speaker={placed.message.speakerName}
              {...drawnOf(placed.message, character?.language)}
              placement={placed}
            />
          ))}
          {doing === 'phoning' ? (
            <p className="phoning muted small">
              <Icon name="phone" size={14} weight={1.8} />
              {name} is using her phone…
            </p>
          ) : doing === 'typing' ? (
            <Typing name={name} />
          ) : null}
          {laid.pending.map(placed => {
            const [clientMessageId, line] = placed.message;

            return (
              <Bubble
                key={clientMessageId}
                own
                text={line.text}
                placement={placed}
                line={line.state}
                onTakeBack={() => {
                  session.takeBack(clientMessageId);
                }}
              />
            );
          })}
        </div>
        <div className="slack" ref={following.slack} aria-hidden="true" />
      </div>
    </section>
  );
}

/** The message box of the thread on screen, at the foot of the bottom surface. */
export function Composer({
  state,
  thread,
  session,
}: {
  readonly state: WebState;
  readonly thread: Thread;
  readonly session: Session;
}) {
  const name = characterName(state, thread.characterId);
  const translated =
    state.health?.characters.find(
      character => character.id === thread.characterId,
    )?.language !== undefined;
  const typed = composerText(state);
  // Nothing can be sent into an address that will never work again; the
  // banner says where to go, and what was typed stays here.
  const reachable = state.connection.status !== 'refused';

  return (
    <form
      className="composer"
      onSubmit={event => {
        event.preventDefault();
        void session.send();
      }}
    >
      <input
        aria-label={`Message ${name}`}
        placeholder={
          translated ? 'Write in your own language' : `Message ${name}`
        }
        value={typed}
        onChange={event => {
          session.compose(event.currentTarget.value);
        }}
        autoComplete="off"
        autoFocus
      />
      <button type="submit" disabled={typed.trim().length === 0 || !reachable}>
        Send
      </button>
    </form>
  );
}

/** The button of each window of hers: its words and its icon. */
const windowButtons: Readonly<
  Record<HerWindow, {readonly words: string; readonly icon: IconName}>
> = {
  world: {words: 'Her World', icon: 'globe'},
  phone: {words: 'Her Phone', icon: 'phone'},
};

/**
 * Opens her phone or her world in its window, and closes it: filled and
 * pressed while that window shows hers, and her phone's with a dot while
 * she is using her phone, whether the window is open or not.
 */
function HerWindowButton({
  herWindow,
  pressed,
  inUse,
  onToggle,
}: {
  readonly herWindow: HerWindow;
  readonly pressed: boolean;
  readonly inUse: boolean;
  readonly onToggle: () => void;
}) {
  const {words, icon} = windowButtons[herWindow];

  return (
    <button
      type="button"
      className="thread-window"
      aria-pressed={pressed}
      onClick={onToggle}
    >
      <Icon name={icon} size={16} weight={1.8} />
      {words}
      {inUse ? (
        <span className="thread-window-dot" role="img" aria-label="In use" />
      ) : null}
    </button>
  );
}

/**
 * Her typing, where her next message will be: her bubble's look and three
 * dots, the middle one stronger. A reader of the screen hears who types.
 */
function Typing({name}: {readonly name: string}) {
  return (
    <p className="typing">
      <span className="typing-dot" aria-hidden="true" />
      <span className="typing-dot" aria-hidden="true" />
      <span className="typing-dot" aria-hidden="true" />
      <span className="visually-hidden">{`${name} is typing`}</span>
    </p>
  );
}

/**
 * A bubble, with what stands above it and under it where the thread's
 * layout puts anything there. Whose it is, `speaker`, is said to a reader
 * of the screen and not drawn: the side and the colour say it to the eye.
 * Its words carry their language when the chat knows it, and a translation
 * stands under them, smaller, past a hairline. A line of the person's not
 * yet committed is faint while it is sending, and one that did not reach
 * her is a button that takes it back into the message box, which takes the
 * focus. Her phone draws its threads with it too.
 */
export function Bubble({
  own = false,
  line,
  speaker,
  placement,
  text,
  lang,
  translation,
  onTakeBack,
}: {
  readonly own?: boolean;
  /** How far a line not yet committed got. */
  readonly line?: LineState;
  readonly speaker?: string;
  readonly placement?: Placement;
  readonly text: string;
  /** The language its words are in, when whoever draws it knows. */
  readonly lang?: string | undefined;
  /** The same words in the other's language. */
  readonly translation?: Form;
  /** Takes back a line that did not reach her. */
  readonly onTakeBack?: () => void;
}) {
  const kind = own ? 'own' : 'theirs';
  const drawn = {
    className: `bubble bubble-${kind}${placement?.joined === true ? ' bubble-joined' : ''}${line === 'sending' ? ' bubble-sending' : ''}`,
    style:
      placement?.colour === undefined
        ? undefined
        : {background: placement.colour},
    title: placement?.when,
    'data-pending': line === undefined ? undefined : 'true',
  };
  const words = (
    <>
      {speaker === undefined ? null : (
        <span className="visually-hidden">{`${speaker}: `}</span>
      )}
      <span className="bubble-text" lang={lang}>
        {text}
      </span>
      {translation === undefined ? null : (
        <span className="bubble-translation" lang={translation.lang}>
          {translation.text}
        </span>
      )}
    </>
  );

  return (
    <>
      {placement?.divider === undefined ? null : (
        <TimeDivider divider={placement.divider} />
      )}
      {line === 'not_delivered' ? (
        <button
          type="button"
          {...drawn}
          aria-label={`Put back in the message box: ${text}`}
          onClick={event => {
            event.currentTarget
              .closest('main')
              ?.querySelector<HTMLElement>('.composer input')
              ?.focus();
            onTakeBack?.();
          }}
        >
          {words}
        </button>
      ) : (
        <div {...drawn}>{words}</div>
      )}
      {placement?.status === undefined ? null : (
        <StatusLine
          status={placement.status}
          notDelivered={line === 'not_delivered'}
        />
      )}
    </>
  );
}

/**
 * How far the holder's newest message got, under it, at the end of the
 * line: the word, then when one read was read; a line that did not reach
 * her in red. Text, so a reader of the screen hears it too.
 */
function StatusLine({
  status,
  notDelivered,
}: {
  readonly status: Status;
  readonly notDelivered: boolean;
}) {
  return (
    <p
      className={`bubble-status${notDelivered ? ' bubble-status-not-delivered' : ''}`}
    >
      <b>{status.word}</b>
      {status.read === undefined ? null : (
        <>
          {' '}
          <time dateTime={status.read.at}>{status.read.when}</time>
        </>
      )}
    </p>
  );
}

/** Where time has passed or the app changed: the app's name where it changed, then the day and the time. */
function TimeDivider({divider}: {readonly divider: Divider}) {
  return (
    <div className="divider">
      {divider.app === undefined ? null : (
        <span className="divider-app">{divider.app}</span>
      )}
      <time dateTime={divider.at}>
        <span className="divider-day">{divider.day}</span> {divider.time}
      </time>
    </div>
  );
}
