import type {CharacterSummary} from '@project02/wire/contract';
import {avatarColor, initialOf} from './look.ts';
import type {Session} from './session.ts';
import {Icon} from './settings-controls.tsx';
import {
  characterName,
  composerText,
  type Thread,
  type WebState,
} from './store.ts';
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
  const turn = state.turns.get(thread.conversationId);
  const drafts = turn?.drafts ?? [];
  // She is using her phone, in a turn of her own as in a line's, until her
  // next reply begins.
  const phoning = state.phoning.has(thread.conversationId);
  // A turn of her own, which no line began, shows nothing until she drafts.
  const writing = turn?.clientMessageId !== undefined && drafts.length === 0;
  const shown = [...(thread.stale ?? []), ...thread.messages];
  // Which pages of its history the thread has read: a page landing moves
  // its lines as a whole, where anything else changes only its end.
  const following = useFollowing(
    `${thread.stale === undefined ? 'read' : 'reading'} ${thread.earlier ?? ''}`,
  );

  return (
    <section className="thread">
      <header className="thread-header">
        <Avatar id={thread.characterId} name={name} />
        <h2 className="thread-name">{name}</h2>
        {character === undefined ? null : <StatePill character={character} />}
        {state.phoneless.has(thread.characterId) ? null : (
          <HerPhoneButton
            pressed={state.phoneWindow === thread.characterId}
            phoning={phoning}
            onToggle={() => {
              session.togglePhone(thread.characterId);
            }}
          />
        )}
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
          {shown.map(message => (
            <Bubble
              key={message.messageId}
              own={message.role === 'user'}
              name={message.speakerName}
              text={message.text}
            />
          ))}
          {drafts.map(draft => (
            <Bubble key={draft.draftId} name={name} text={draft.text} draft />
          ))}
          {phoning ? (
            <p className="typing muted small">
              <Icon name="phone" size={14} weight={1.8} />
              {name} is using her phone…
            </p>
          ) : writing ? (
            <p className="typing muted small">{name} is writing…</p>
          ) : null}
          {pending.map(([clientMessageId, line]) => (
            <Bubble key={clientMessageId} own text={line.text} pending />
          ))}
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
        placeholder={`Message ${name}`}
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

/**
 * Opens her phone in its window, and closes it: filled and pressed while
 * that window shows her phone, and with a dot while she is using her
 * phone, whether the window is open or not.
 */
function HerPhoneButton({
  pressed,
  phoning,
  onToggle,
}: {
  readonly pressed: boolean;
  readonly phoning: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="thread-phone"
      aria-pressed={pressed}
      onClick={onToggle}
    >
      <Icon name="phone" size={16} weight={1.8} />
      Her Phone
      {phoning ? (
        <span className="thread-phone-dot" role="img" aria-label="In use" />
      ) : null}
    </button>
  );
}

function Bubble({
  own = false,
  draft = false,
  pending = false,
  name,
  text,
}: {
  readonly own?: boolean;
  readonly draft?: boolean;
  readonly pending?: boolean;
  readonly name?: string;
  readonly text: string;
}) {
  const kind = own ? 'own' : 'theirs';

  return (
    <div
      className={`bubble bubble-${kind}${draft ? ' bubble-draft' : ''}${pending ? ' bubble-pending' : ''}`}
      data-draft={draft ? 'true' : undefined}
      data-pending={pending ? 'true' : undefined}
    >
      {own || name === undefined ? null : (
        <span className="bubble-name">{name}</span>
      )}
      <span className="bubble-text">{text}</span>
    </div>
  );
}
