import {useEffect, useRef} from 'react';

import type {CharacterSummary} from '@project02/wire/contract';
import {avatarColor, initialOf} from './look.ts';
import type {Session} from './session.ts';
import {composerText, type Thread, type WebState} from './store.ts';

/** States a character rests in; one switched off and resting is off. */
const restingStates = new Set<CharacterSummary['state']>([
  'not_started',
  'stopped',
  'failed',
]);

/**
 * A character's state as its pill says it. One that is switched off and
 * not running says off instead; one still running or on its way down
 * says so, since that is what the person sees happening.
 */
export function StatePill({character}: {readonly character: CharacterSummary}) {
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
  const name = character?.displayName ?? thread.characterId;
  const pending = [...state.pending].filter(
    ([, line]) => line.conversationId === thread.conversationId,
  );
  const turn = state.turns.get(thread.conversationId);
  const drafts = turn?.drafts ?? [];
  // A turn of her own, which no line began, shows nothing until she drafts.
  const writing = turn?.clientMessageId !== undefined && drafts.length === 0;
  const typed = composerText(state);
  // Nothing can be sent into an address that will never work again; the
  // banner says where to go, and what was typed stays here.
  const reachable = state.connection.status !== 'refused';
  const scroller = useRef<HTMLDivElement>(null);
  // The view follows the thread's end unless the person scrolled up to read.
  const following = useRef(true);
  const shown = [...(thread.stale ?? []), ...thread.messages];
  const lastMessageId = shown.at(-1)?.messageId;

  useEffect(() => {
    if (following.current) {
      scroller.current?.scrollTo({top: scroller.current.scrollHeight});
    }
  }, [lastMessageId, turn?.drafts, pending.length]);

  return (
    <section className="thread">
      <header className="thread-header">
        <Avatar id={thread.characterId} name={name} />
        <h2 className="thread-name">{name}</h2>
        {character === undefined ? null : <StatePill character={character} />}
      </header>
      {thread.unread === undefined ? null : (
        <p className="notice" role="status">
          {thread.unread}
        </p>
      )}
      <div
        className="messages"
        ref={scroller}
        onScroll={event => {
          const {scrollHeight, scrollTop, clientHeight} = event.currentTarget;

          following.current = scrollHeight - scrollTop - clientHeight < 80;
        }}
      >
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
        {writing ? (
          <p className="typing muted small">{name} is writing…</p>
        ) : null}
        {pending.map(([clientMessageId, line]) => (
          <Bubble key={clientMessageId} own text={line.text} pending />
        ))}
      </div>
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
        <button
          type="submit"
          disabled={typed.trim().length === 0 || !reachable}
        >
          Send
        </button>
      </form>
    </section>
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
