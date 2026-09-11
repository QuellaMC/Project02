import {useSyncExternalStore} from 'react';

import type {CharacterSummary} from '../../gateway/api/index.ts';
import type {Session} from './session.ts';
import {Avatar, stateLabel, ThreadPane} from './thread.tsx';

export function App({session}: {readonly session: Session}) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const {connection, health, thread} = state;
  const configProblems =
    health?.config.diagnostics.filter(
      diagnostic => diagnostic.severity === 'error',
    ) ?? [];

  return (
    <div className="page">
      {connection.status === 'refused' ? (
        <p className="banner banner-refused" role="alert">
          {connection.message} Open the address <code>pnpm serve</code> printed.
        </p>
      ) : null}
      {configProblems.map(diagnostic => (
        <p className="banner banner-warning" key={diagnostic.message}>
          {diagnostic.message}
        </p>
      ))}
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
          />
        )}
        {health?.packages.diagnostics.map(diagnostic => (
          <p className="muted small" key={diagnostic.path}>
            {diagnostic.path}: {diagnostic.message}
          </p>
        ))}
      </aside>
      <main className="main">
        {thread === undefined ? (
          <p className="muted empty">
            {health !== undefined && health.characters.length > 1
              ? 'Pick a character.'
              : ''}
          </p>
        ) : (
          <ThreadPane state={state} thread={thread} session={session} />
        )}
      </main>
    </div>
  );
}

function Roster({
  characters,
  openId,
  onOpen,
}: {
  readonly characters: readonly CharacterSummary[];
  readonly openId: string | undefined;
  readonly onOpen: (characterId: string) => void;
}) {
  if (characters.length === 0) {
    return <p className="muted">No characters are installed.</p>;
  }

  return (
    <ul className="roster-list">
      {characters.map(character => (
        <li key={character.id}>
          <button
            type="button"
            className={`roster-item${character.id === openId ? ' roster-item-open' : ''}`}
            onClick={() => {
              onOpen(character.id);
            }}
          >
            <Avatar name={character.displayName} />
            <span className="roster-name">{character.displayName}</span>
            <span className={`pill pill-${character.state}`}>
              {stateLabel(character.state)}
            </span>
            {character.diagnostic === undefined ? null : (
              <span className="muted small roster-diagnostic">
                {character.diagnostic}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
