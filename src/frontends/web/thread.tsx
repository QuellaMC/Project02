import {useEffect, useRef, useState} from 'react';

import type {
  CharacterSummary,
  GatewayConfirmationDecision,
  PendingConfirmation,
} from '../../gateway/api/index.ts';
import type {Session} from './session.ts';
import type {Thread, WebState} from './store.ts';

/** States a line cannot reach; the daemon holds a line through the rest. */
const blockingStates = new Set<CharacterSummary['state']>([
  'failed',
  'stopped',
  'not_started',
]);

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
  const scroller = useRef<HTMLDivElement>(null);
  // The view follows the thread's end unless the person scrolled up to read.
  const following = useRef(true);
  const lastMessageId = thread.messages.at(-1)?.messageId;

  useEffect(() => {
    if (following.current) {
      scroller.current?.scrollTo({top: scroller.current.scrollHeight});
    }
  }, [lastMessageId, thread.drafts, thread.pending, cards.length]);

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
      {character !== undefined && blockingStates.has(character.state) ? (
        <div className="banner banner-state" role="status">
          <span>
            {name} is {stateLabel(character.state)}
            {character.diagnostic === undefined
              ? '.'
              : `: ${character.diagnostic}`}
          </span>
          <button
            type="button"
            onClick={() => {
              void session.start(character.id);
            }}
          >
            Start
          </button>
        </div>
      ) : null}
      {character?.maintenance === undefined ? null : (
        <p className="banner banner-warning">{character.maintenance.message}</p>
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
        {thread.messages.map(message => (
          <Bubble
            key={message.messageId}
            own={message.speakerId === thread.userParticipantId}
            name={message.speakerName}
            text={message.text}
          />
        ))}
        {[...thread.drafts].map(([draftId, text]) => (
          <Bubble key={draftId} name={name} text={text} draft />
        ))}
        {thread.busy && thread.drafts.size === 0 ? (
          <p className="typing muted small">{name} is writing…</p>
        ) : null}
        {[...thread.pending].map(([clientMessageId, line]) => (
          <Bubble key={clientMessageId} own text={line.text} pending />
        ))}
        {cards.map(pending => (
          <ConfirmationCard
            key={pending.id}
            pending={pending}
            onAnswer={decision => {
              void session.answer(pending.id, decision);
            }}
          />
        ))}
      </div>
      {state.notice === undefined ? null : (
        <p className="notice" role="status">
          {state.notice}
        </p>
      )}
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
          value={state.composer}
          onChange={event => {
            session.compose(event.currentTarget.value);
          }}
          autoComplete="off"
          autoFocus
        />
        <button type="submit" disabled={state.composer.trim().length === 0}>
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
  readonly onAnswer: (decision: GatewayConfirmationDecision) => void;
}) {
  const [answering, setAnswering] = useState(false);
  const expires = new Date(pending.deadlineAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const answer = (decision: GatewayConfirmationDecision): void => {
    setAnswering(true);
    onAnswer(decision);
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
        <span className="muted small">expires at {expires}</span>
        <button
          type="button"
          disabled={answering}
          onClick={() => {
            answer('approved');
          }}
        >
          Approve
        </button>
        <button
          type="button"
          className="secondary"
          disabled={answering}
          onClick={() => {
            answer('denied');
          }}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
