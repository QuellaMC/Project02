import {useSyncExternalStore} from 'react';

import type {CharacterSummary} from '../../gateway/api/index.ts';
import type {Session} from './session.ts';
import {Avatar, stateLabel, ThreadPane} from './thread.tsx';

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
        {configProblems.map(diagnostic => (
          <p className="banner banner-warning" key={diagnostic.message}>
            {diagnostic.message}
          </p>
        ))}
      </header>
      <aside className="roster" aria-label="Characters">
        <h1 className="roster-title">Characters</h1>
        {health === undefined ? (
          <p className="muted">
            {connection.status === 'connecting' ? 'Connecting…' : ''}
          </p>
        ) : (
          <Roster
            characters={health.characters}
            openId={thread?.characterId}
            onOpen={characterId => {
              void session.open(characterId);
            }}
            onStart={characterId => {
              void session.start(characterId);
            }}
          />
        )}
        {health?.packages.diagnostics.map(diagnostic => (
          <p className="muted small" key={diagnostic.path}>
            {diagnostic.path}: {diagnostic.message}
          </p>
        ))}
      </aside>
      <main className="main">
        {state.notice === undefined ? null : (
          <p className="notice" role="status">
            {state.notice}
          </p>
        )}
        {thread === undefined ? (
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
}: {
  readonly characters: readonly CharacterSummary[];
  readonly openId: string | undefined;
  readonly onOpen: (characterId: string) => void;
  readonly onStart: (characterId: string) => void;
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
            <span className={`pill pill-${character.state}`}>
              {stateLabel(character.state)}
            </span>
          </button>
          {blockingStates.has(character.state) ? (
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
