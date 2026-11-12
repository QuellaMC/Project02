/**
 * The first run's welcome, in front of the chat while the home's settings
 * give a character no AI model: the person's name, then the service and
 * its key, then the way into the chat. Each box saves as the window's
 * boxes do, into the home's settings.
 */
import type {ReactNode} from 'react';

import type {CharacterSummary} from '@project02/wire/contract';
import type {Session} from './session.ts';
import {
  BackButton,
  Check,
  Face,
  Icon,
  KeyBox,
  Problems,
  SelectBox,
  Tile,
} from './settings-controls.tsx';
import {
  choiceWords,
  keyPlaceholder,
  valueNow,
  welcomeKey,
  welcomeReady,
} from './settings-model.ts';
import {fieldAt, home, ownText, rowKey, viewOf, type Row} from './settings.ts';
import type {Settings, WebState} from './store.ts';

const nameRow: Row = {
  target: home,
  place: {kind: 'host', name: 'userDisplayName'},
};
const serviceRow: Row = {
  target: home,
  place: {kind: 'host', name: 'roleModelProvider'},
};

export function Welcome({
  state,
  settings,
  step,
  session,
}: {
  readonly state: WebState;
  readonly settings: Settings;
  readonly step: 1 | 2 | 3;
  readonly session: Session;
}) {
  const character = state.health?.characters[0];

  return (
    <div className="welcome">
      <main className="welcome-card">
        <div className="welcome-top">
          {step === 1 ? null : (
            <BackButton
              label="Back"
              onClick={() => {
                session.welcomeBack();
              }}
            />
          )}
          <span className="welcome-step">Step {step} of 3</span>
        </div>
        {step === 1 ? (
          <NameStep
            settings={settings}
            character={character}
            session={session}
          />
        ) : step === 2 ? (
          <ModelStep settings={settings} session={session} />
        ) : (
          <DoneStep
            settings={settings}
            character={character}
            session={session}
          />
        )}
      </main>
    </div>
  );
}

function Heading({
  art,
  title,
  text,
}: {
  readonly art: ReactNode;
  readonly title: string;
  readonly text: string;
}) {
  return (
    <div className="welcome-heading">
      {art}
      <div className="welcome-words">
        <h1 className="welcome-title">{title}</h1>
        <p className="welcome-text">{text}</p>
      </div>
    </div>
  );
}

function Continue({
  ready = true,
  onClick,
  children = 'Continue',
}: {
  readonly ready?: boolean;
  readonly onClick: () => void;
  readonly children?: string;
}) {
  return (
    <button
      type="button"
      className={`welcome-button${ready ? '' : ' welcome-button-dim'}`}
      aria-disabled={!ready}
      onClick={() => {
        if (ready) {
          onClick();
        }
      }}
    >
      {children}
    </button>
  );
}

function NameStep({
  settings,
  character,
  session,
}: {
  readonly settings: Settings;
  readonly character: CharacterSummary | undefined;
  readonly session: Session;
}) {
  const view = viewOf(settings, home);
  const field = view === undefined ? undefined : fieldAt(view, nameRow.place);
  const key = rowKey(nameRow);
  const name = character?.displayName;

  return (
    <>
      <Heading
        art={
          character === undefined ? null : (
            <Face
              id={character.id}
              name={character.displayName}
              size="welcome"
            />
          )
        }
        title="Welcome"
        text={
          name === undefined
            ? 'What should your characters call you?'
            : `${name} is ready to meet you. What should she call you?`
        }
      />
      <div className="welcome-field">
        <label htmlFor="welcome-name" className="welcome-label">
          Your Name
        </label>
        <span className="box">
          <input
            id="welcome-name"
            type="text"
            className="input"
            value={
              settings.edits.get(key) ??
              (field === undefined ? '' : ownText(field))
            }
            placeholder="What she calls you"
            autoComplete="off"
            onChange={event => {
              session.edit(nameRow, event.currentTarget.value);
            }}
            onBlur={() => {
              void session.save(nameRow);
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                void session.welcomeNext();
              }
            }}
          />
          {settings.saved?.key === key ? (
            <Check key={settings.saved.ticket} />
          ) : null}
        </span>
        <Problems problems={problemOf(settings, nameRow)} />
      </div>
      <Continue
        onClick={() => {
          void session.welcomeNext();
        }}
      />
    </>
  );
}

function problemOf(settings: Settings, row: Row): readonly string[] {
  const problem = settings.problems.get(rowKey(row));

  return problem === undefined ? [] : [problem];
}

function ModelStep({
  settings,
  session,
}: {
  readonly settings: Settings;
  readonly session: Session;
}) {
  const view = viewOf(settings, home);
  const service =
    view === undefined ? undefined : fieldAt(view, serviceRow.place);
  const key = welcomeKey(settings);
  const chosen =
    service === undefined ? undefined : valueNow(settings, serviceRow, service);
  const saved = settings.saved;

  return (
    <>
      <Heading
        art={<Tile icon="sparkle" tint="indigo" size="welcome" />}
        title="Choose an AI Model"
        text="Your characters think with it."
      />
      {service === undefined ? null : (
        <div className="welcome-field">
          <label htmlFor="welcome-service" className="welcome-label">
            Service
          </label>
          <SelectBox
            id="welcome-service"
            value={chosen}
            options={(service.allowedValues ?? []).map(value => ({
              value,
              label: choiceWords(service, value),
            }))}
            none="Choose a Service"
            onChoose={value => {
              void session.choose(serviceRow, value);
            }}
          />
          <Problems problems={problemOf(settings, serviceRow)} />
        </div>
      )}
      {key === undefined ? null : (
        <div className="welcome-field">
          <label htmlFor="welcome-key" className="welcome-label">
            API Key
          </label>
          <KeyBox
            id="welcome-key"
            text={settings.edits.get(rowKey(key.row)) ?? ''}
            stored={key.field.authored.configured}
            placeholder={focused => keyPlaceholder(key.field, focused)}
            {...(saved?.key === rowKey(key.row) ? {check: saved.ticket} : {})}
            onChange={text => {
              session.edit(key.row, text);
            }}
            onCommit={() => {
              void session.save(key.row);
            }}
          />
          <Problems problems={problemOf(settings, key.row)} />
          <p className="welcome-hint">
            Paste it and press Return. {key.service.keyFrom}
          </p>
        </div>
      )}
      <Continue
        ready={welcomeReady(settings)}
        onClick={() => {
          void session.welcomeNext();
        }}
      />
      <button
        type="button"
        className="welcome-later"
        onClick={() => {
          session.finishWelcome();
        }}
      >
        Set Up Later
      </button>
    </>
  );
}

function DoneStep({
  settings,
  character,
  session,
}: {
  readonly settings: Settings;
  readonly character: CharacterSummary | undefined;
  readonly session: Session;
}) {
  const view = viewOf(settings, home);
  const field = view === undefined ? undefined : fieldAt(view, nameRow.place);
  const name = field === undefined ? '' : ownText(field).trim();

  return (
    <>
      <Heading
        art={
          character === undefined ? null : (
            <span className="welcome-done">
              <Face
                id={character.id}
                name={character.displayName}
                size="welcome"
              />
              <span className="welcome-badge" aria-hidden="true">
                <Icon name="check" size={11} weight={3.2} />
              </span>
            </span>
          )
        }
        title={`You're All Set, ${name === '' ? 'Friend' : name}`}
        text={`${character?.displayName ?? 'She'} is ready. You can add Telegram and long-term memory any time in Settings.`}
      />
      <Continue
        onClick={() => {
          session.finishWelcome();
        }}
      >
        Start Chatting
      </Continue>
    </>
  );
}
