import {useSyncExternalStore} from 'react';

import type {CharacterSummary} from '@project02/wire/contract';
import {askersOf} from './dock.ts';
import {Bottom} from './dock-view.tsx';
import type {Session} from './session.ts';
import {SettingsWindow} from './settings-window.tsx';
import type {WebState} from './store.ts';
import {Avatar, StatePill, ThreadPane} from './thread.tsx';
import {Welcome} from './welcome.tsx';

/** States a line cannot reach; the daemon holds a line through the rest. */
const blockingStates = new Set<CharacterSummary['state']>([
  'failed',
  'stopped',
  'not_started',
]);

export function App({session}: {readonly session: Session}) {
  const state = useSyncExternalStore(session.subscribe, session.getState);
  const {settings} = state;

  if (settings === undefined) {
    return <Chat state={state} session={session} />;
  }

  // The window and the welcome take the whole page; the chat waits behind.
  return (
    <>
      <header className="banners">
        <ConnectionBanners state={state} />
      </header>
      {settings.screen.kind === 'welcome' ? (
        <Welcome
          state={state}
          settings={settings}
          step={settings.screen.step}
          session={session}
        />
      ) : (
        <SettingsWindow
          state={state}
          settings={settings}
          page={settings.screen.page}
          session={session}
        />
      )}
    </>
  );
}

/** Why the page's address will never work, and where to go instead: said by every surface of the page. */
export function AddressRefused({message}: {readonly message: string}) {
  return (
    <>
      {message} This address does not work: open the one{' '}
      <code>project02 serve</code> printed, or open the app again.
    </>
  );
}

function ConnectionBanners({state}: {readonly state: WebState}) {
  const {connection} = state;

  return (
    <>
      {connection.status === 'refused' ? (
        <p className="banner banner-refused" role="alert">
          <AddressRefused message={connection.message} />
        </p>
      ) : null}
      {connection.status === 'connecting' ? (
        <p className="banner muted">Connecting…</p>
      ) : null}
    </>
  );
}

function Chat({
  state,
  session,
}: {
  readonly state: WebState;
  readonly session: Session;
}) {
  const {health, thread} = state;
  const configProblems =
    health?.config.diagnostics.filter(
      diagnostic => diagnostic.severity === 'error',
    ) ?? [];
  const first = health?.characters[0];

  return (
    <div className="page">
      <header className="banners">
        <ConnectionBanners state={state} />
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
              void session.openSettings(
                first === undefined
                  ? {kind: 'you'}
                  : {kind: 'character', characterId: first.id},
              );
            }}
          >
            Settings
          </button>
        </div>
        {health === undefined ? null : (
          <Roster
            characters={health.characters}
            openId={thread?.characterId}
            unseen={state.unseen}
            askers={askersOf(state)}
            onOpen={characterId => {
              void session.open(characterId);
            }}
            onStart={characterId => {
              void session.start(characterId);
            }}
            onSettings={characterId => {
              void session.openSettings({kind: 'character', characterId});
            }}
            onModel={() => {
              void session.openSettings({kind: 'model'});
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
        {/* Everything waiting is answered here, whichever character it
            belongs to and whichever surface raised it: a person who sees
            the whole roster answers for the whole roster, and one raised
            for a character nobody is reading must not expire unseen. A
            pairing request is the home's, and waits among them. */}
        <Bottom state={state} session={session} />
      </main>
    </div>
  );
}

function Roster({
  characters,
  openId,
  unseen,
  askers,
  onOpen,
  onStart,
  onSettings,
  onModel,
}: {
  readonly characters: readonly CharacterSummary[];
  readonly openId: string | undefined;
  /** The characters with a reply the person has not seen, each marked by a dot after her name. */
  readonly unseen: ReadonlySet<string>;
  /** The characters with an ask waiting for the person: each says so where she says how she stands. */
  readonly askers: ReadonlySet<string>;
  readonly onOpen: (characterId: string) => void;
  readonly onStart: (characterId: string) => void;
  readonly onSettings: (characterId: string) => void;
  /** Opens AI Model, for a character who needs one. */
  readonly onModel: () => void;
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
            <Avatar id={character.id} name={character.displayName} />
            <span className="roster-line">
              <span className="roster-name">{character.displayName}</span>
              {unseen.has(character.id) ? (
                <span
                  className="roster-unseen"
                  role="img"
                  aria-label="New message"
                />
              ) : null}
            </span>
            <StatePill
              character={character}
              asking={askers.has(character.id)}
            />
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
          {character.state === 'needs_model' ? (
            // What she needs is said in plain words, and leads to where it is set.
            <button
              type="button"
              className="roster-note roster-link"
              onClick={onModel}
            >
              {character.diagnostic ?? 'Choose an AI model.'}
            </button>
          ) : character.diagnostic === undefined ? null : (
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
