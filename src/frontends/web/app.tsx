import {useState, useSyncExternalStore} from 'react';

import type {
  CharacterSummary,
  GatewayConfirmationDecision,
  PendingConfirmation,
} from '../../gateway/api/index.ts';
import {webSource, type Session} from './session.ts';
import {SettingsScreen} from './settings.tsx';
import {characterName} from './store.ts';
import {Avatar, StatePill, ThreadPane} from './thread.tsx';

/** States a line cannot reach; the daemon holds a line through the rest. */
const blockingStates = new Set<CharacterSummary['state']>([
  'failed',
  'stopped',
  'not_started',
]);

export function App({session}: {readonly session: Session}) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const {connection, health, thread} = state;
  const configProblems =
    health?.config.diagnostics.filter(
      diagnostic => diagnostic.severity === 'error',
    ) ?? [];

  return (
    <div className="page">
      <header className="banners">
        {connection.status === 'refused' ? (
          <p className="banner banner-refused" role="alert">
            {connection.message} Open the address <code>pnpm serve</code>{' '}
            printed.
          </p>
        ) : null}
        {connection.status === 'connecting' ? (
          <p className="banner muted">Connecting…</p>
        ) : null}
        {configProblems.map((diagnostic, problem) => (
          // Two fields can fail the same way, so the banner names the
          // field: the message alone says what is wrong, not what to fix.
          <p className="banner banner-warning" key={problem}>
            {diagnostic.path === undefined
              ? diagnostic.message
              : `${diagnostic.path}: ${diagnostic.message}`}
          </p>
        ))}
      </header>
      <aside className="roster" aria-label="Characters">
        <div className="roster-header">
          <h1 className="roster-title">Characters</h1>
          <button
            type="button"
            className="secondary roster-settings"
            onClick={() => {
              void session.openSettings({scope: 'global'});
            }}
          >
            Settings
          </button>
        </div>
        {health === undefined ? null : (
          <Roster
            characters={health.characters}
            openId={
              state.settings === undefined ? thread?.characterId : undefined
            }
            onOpen={characterId => {
              // A character clicked is a thread wanted, whatever screen is up.
              session.closeSettings();
              void session.open(characterId);
            }}
            onStart={characterId => {
              void session.start(characterId);
            }}
            onSettings={characterId => {
              void session.openSettings({scope: 'character', characterId});
            }}
          />
        )}
        {health?.packages.diagnostics.map((diagnostic, problem) => (
          <p className="muted small" key={problem}>
            {diagnostic.path}: {diagnostic.message}
          </p>
        ))}
      </aside>
      <main className="main">
        {state.notices.map(notice => (
          <p className="notice" role="status" key={notice}>
            {notice}
          </p>
        ))}
        {state.confirmations.length === 0 ? null : (
          // Every confirmation waiting is on the page, whichever character
          // it belongs to and whichever surface raised it: a person who
          // sees the whole roster answers for the whole roster, and one
          // raised for a character nobody is reading must not expire
          // unseen.
          <div className="cards">
            {state.confirmations.map(card => (
              <ConfirmationCard
                key={card.id}
                pending={card}
                characterName={characterName(state, card.characterId)}
                onAnswer={decision => session.answer(card.id, decision)}
              />
            ))}
          </div>
        )}
        {state.settings !== undefined ? (
          <SettingsScreen
            state={state}
            page={state.settings}
            session={session}
          />
        ) : thread === undefined ? (
          <p className="muted empty">
            {health !== undefined && health.characters.length > 1
              ? 'Pick a character.'
              : ''}
          </p>
        ) : (
          // Keyed by the thread: another character opens at its own end,
          // not where the last one was read.
          <ThreadPane
            key={thread.conversationId}
            state={state}
            thread={thread}
            session={session}
          />
        )}
      </main>
    </div>
  );
}

function Roster({
  characters,
  openId,
  onOpen,
  onStart,
  onSettings,
}: {
  readonly characters: readonly CharacterSummary[];
  readonly openId: string | undefined;
  readonly onOpen: (characterId: string) => void;
  readonly onStart: (characterId: string) => void;
  readonly onSettings: (characterId: string) => void;
}) {
  if (characters.length === 0) {
    return <p className="muted">No characters are installed.</p>;
  }

  return (
    <ul className="roster-list">
      {characters.map(character => (
        <li
          key={character.id}
          className={`roster-item${character.id === openId ? ' roster-item-open' : ''}`}
        >
          <button
            type="button"
            className="roster-open"
            onClick={() => {
              onOpen(character.id);
            }}
          >
            <Avatar name={character.displayName} />
            <span className="roster-name">{character.displayName}</span>
            <StatePill character={character} />
          </button>
          {/* Start is the retry for a character that is on; one that is off is turned on in its settings. */}
          {character.enabled && blockingStates.has(character.state) ? (
            <button
              type="button"
              className="roster-start"
              onClick={() => {
                onStart(character.id);
              }}
            >
              Start
            </button>
          ) : null}
          <button
            type="button"
            className="secondary roster-gear"
            aria-label={`Settings for ${character.displayName}`}
            title={`Settings for ${character.displayName}`}
            onClick={() => {
              onSettings(character.id);
            }}
          >
            ⚙
          </button>
          {character.diagnostic === undefined ? null : (
            <p className="muted small roster-note">{character.diagnostic}</p>
          )}
          {character.maintenance === undefined ? null : (
            <p className="muted small roster-note">
              {character.maintenance.message}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function ConfirmationCard({
  pending,
  characterName,
  onAnswer,
}: {
  readonly pending: PendingConfirmation;
  readonly characterName: string;
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
          {characterName} · expires at {expires}
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
