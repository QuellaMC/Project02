import {useEffect, useRef, useState} from 'react';

import type {
  CharacterSummary,
  GatewayConfirmationDecision,
  PendingConfirmation,
} from '../../gateway/api/index.ts';
import {webSource, type Session} from './session.ts';
import {composerText, type Thread, type WebState} from './store.ts';

export function stateLabel(state: CharacterSummary['state']): string {
  return state.replace('_', ' ');
}

export function Avatar({name}: {readonly name: string}) {
  return (
    <span className="avatar" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
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
  const cards = state.confirmations.filter(
    pending => pending.characterId === thread.characterId,
  );
  const pending = [...state.pending].filter(
    ([, line]) => line.conversationId === thread.conversationId,
  );
  const turn = state.turns.get(thread.conversationId);
  const drafts = [...(turn?.drafts ?? [])];
  const typed = composerText(state);
  // Nothing can be sent into an address that will never work again; the
  // banner says where to go, and what was typed stays here.
  const reachable = state.connection.status !== 'refused';
  const scroller = useRef<HTMLDivElement>(null);
  // The view follows the thread's end unless the person scrolled up to read.
  const following = useRef(true);
  const shown = [...thread.stale, ...thread.messages];
  const lastMessageId = shown.at(-1)?.messageId;

  useEffect(() => {
    if (following.current) {
      scroller.current?.scrollTo({top: scroller.current.scrollHeight});
    }
  }, [lastMessageId, turn?.drafts, pending.length, cards.length]);

  return (
    <section className="thread">
      <header className="thread-header">
        <Avatar name={name} />
        <h2 className="thread-name">{name}</h2>
        {character === undefined ? null : (
          <span className={`pill pill-${character.state}`}>
            {stateLabel(character.state)}
          </span>
        )}
      </header>
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
            own={message.speakerId === thread.userParticipantId}
            name={message.speakerName}
            text={message.text}
          />
        ))}
        {drafts.map(([draftId, text]) => (
          <Bubble key={draftId} name={name} text={text} draft />
        ))}
        {turn?.busy === true && drafts.length === 0 ? (
          <p className="typing muted small">{name} is writing…</p>
        ) : null}
        {pending.map(([clientMessageId, line]) => (
          <Bubble key={clientMessageId} own text={line.text} pending />
        ))}
        {cards.map(card => (
          <ConfirmationCard
            key={card.id}
            pending={card}
            onAnswer={decision => session.answer(card.id, decision)}
          />
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

function ConfirmationCard({
  pending,
  onAnswer,
}: {
  readonly pending: PendingConfirmation;
  readonly onAnswer: (decision: GatewayConfirmationDecision) => Promise<void>;
}) {
  // The buttons rest while an answer is on its way; an answer that could
  // not be delivered gives them back, since the card is still there.
  const [answering, setAnswering] = useState(false);
  const expires = new Date(pending.deadlineAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const answer = async (decision: GatewayConfirmationDecision) => {
    setAnswering(true);
    await onAnswer(decision);
    setAnswering(false);
  };

  return (
    <div className="card" role="group" aria-label="Confirmation">
      <p className="card-title">
        Confirm {pending.request.toolName}{' '}
        <span className="muted">· {pending.request.pluginId}</span>
      </p>
      <p className="card-summary">{pending.request.summary}</p>
      <pre className="card-preview">
        {JSON.stringify(pending.request.preview, null, 2)}
      </pre>
      <div className="card-actions">
        <span className="muted small">
          expires at {expires}
          {pending.turn === undefined || pending.turn.source === webSource
            ? ''
            : ` · raised on ${pending.turn.source}`}
        </span>
        <button
          type="button"
          disabled={answering}
          onClick={() => {
            void answer('approved');
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className="secondary"
          disabled={answering}
          onClick={() => {
            void answer('denied');
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
