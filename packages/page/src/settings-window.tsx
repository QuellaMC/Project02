/**
 * The settings window: the sidebar, and the page it is on. Every page
 * draws from the views and health the store holds; what a page shows is
 * the settings model's to say.
 */
import type {ReactNode} from 'react';

import type {Session} from './session.ts';
import {AddPage} from './settings-add.tsx';
import {AppFilePage, AppPage, GetAppsPage} from './settings-apps.tsx';
import {
  CharacterModelPage,
  CharacterPage,
  FeaturePage,
} from './settings-character.tsx';
import {
  BackButton,
  Face,
  FileButton,
  Icon,
  PersonFace,
  Tile,
} from './settings-controls.tsx';
import type {Ctx} from './settings-fields.tsx';
import {findings, marks, sidebarOf} from './settings-model.ts';
import {
  AdvancedPage,
  ConnectionPage,
  ModelPage,
  PluginPage,
  YouPage,
} from './settings-pages.tsx';
import {BotPage, TelegramPage} from './settings-telegram.tsx';
import {characterFileTypes} from './settings.ts';
import {
  characterName,
  type Settings,
  type SettingsPage,
  type WebState,
} from './store.ts';

export function SettingsWindow({
  state,
  settings,
  page,
  session,
}: {
  readonly state: WebState;
  readonly settings: Settings;
  readonly page: SettingsPage;
  readonly session: Session;
}) {
  const ctx: Ctx = {
    state,
    settings,
    session,
    findings: findings(settings, id => characterName(state, id)),
  };

  return (
    <div className="window">
      <Sidebar ctx={ctx} page={page} />
      <main className="window-main">
        <div className="window-column">
          {state.notices.map(notice => (
            <p className="window-notice" role="status" key={notice}>
              {notice}
            </p>
          ))}
          <PageShown ctx={ctx} page={page} />
        </div>
      </main>
    </div>
  );
}

function PageShown({
  ctx,
  page,
}: {
  readonly ctx: Ctx;
  readonly page: SettingsPage;
}) {
  switch (page.kind) {
    case 'you':
      return <YouPage ctx={ctx} />;
    case 'character':
      return <CharacterPage ctx={ctx} characterId={page.characterId} />;
    case 'remove':
      return (
        <CharacterPage
          ctx={ctx}
          characterId={page.characterId}
          removing={page}
        />
      );
    case 'model':
      return <ModelPage ctx={ctx} />;
    case 'telegram':
      return <TelegramPage ctx={ctx} />;
    case 'connection':
      return <ConnectionPage ctx={ctx} pluginId={page.pluginId} />;
    case 'advanced':
      return <AdvancedPage ctx={ctx} />;
    case 'feature':
      return (
        <FeaturePage
          ctx={ctx}
          characterId={page.characterId}
          pluginId={page.pluginId}
        />
      );
    case 'character-model':
      return <CharacterModelPage ctx={ctx} characterId={page.characterId} />;
    case 'bot':
      return <BotPage ctx={ctx} page={page} />;
    case 'plugin':
      return <PluginPage ctx={ctx} namespace={page.namespace} id={page.id} />;
    case 'add':
      return <AddPage ctx={ctx} page={page} />;
    case 'app':
      return <AppPage ctx={ctx} page={page} />;
    case 'get-apps':
      return <GetAppsPage ctx={ctx} characterId={page.characterId} />;
    case 'app-file':
      return <AppFilePage ctx={ctx} page={page} />;
  }
}

function Sidebar({
  ctx,
  page,
}: {
  readonly ctx: Ctx;
  readonly page: SettingsPage;
}) {
  const {state, settings, session, findings: found} = ctx;
  const characters = state.health?.characters ?? [];
  const sidebar = sidebarOf(settings, characters, found, state.advanced);
  const go = (to: SettingsPage) => () => {
    session.goTo(to);
  };

  return (
    <nav aria-label="Settings" className="sidebar">
      <div className="sidebar-top">
        <BackButton
          label="Back to Chat"
          onClick={() => {
            session.closeSettings();
          }}
        />
        <h1 className="sidebar-title">Settings</h1>
      </div>
      <SideButton
        you
        current={marks(page, {kind: 'you'})}
        onClick={go({kind: 'you'})}
      >
        <PersonFace name={sidebar.you} size="you" />
        <span className="label label-two">
          <span className="side-you-name">{sidebar.you}</span>
          <span className="detail">You</span>
        </span>
      </SideButton>
      <div className="side-group">
        <span className="side-group-title">Characters</span>
        {sidebar.characters.map(entry => (
          <SideButton
            key={entry.id}
            current={marks(page, entry.page)}
            onClick={go(entry.page)}
            value={entry.value}
            dot={entry.dot}
          >
            <Face id={entry.id} name={entry.label} size="side" />
            <span className="side-label">{entry.label}</span>
          </SideButton>
        ))}
        <FileButton
          className="side-item side-add"
          accept={characterFileTypes}
          current={page.kind === 'add'}
          onChoose={file => {
            void session.chooseCharacterFile(file);
          }}
        >
          <span className="side-add-ring" aria-hidden="true">
            <Icon name="plus" size={13} weight={2.4} />
          </span>
          <span className="side-label">Add Character</span>
        </FileButton>
      </div>
      <div className="side-group">
        <span className="side-group-title">Connections</span>
        {sidebar.connections.map(entry => (
          <SideButton
            key={entry.label}
            current={marks(page, entry.page)}
            onClick={go(entry.page)}
            value={entry.value}
            dot={entry.dot}
          >
            <Tile icon={entry.icon} tint={entry.tint} size="side" />
            <span className="side-label">{entry.label}</span>
          </SideButton>
        ))}
      </div>
      <SideButton
        current={marks(page, sidebar.advanced.page)}
        onClick={go(sidebar.advanced.page)}
        value={sidebar.advanced.value}
        dot={sidebar.advanced.dot}
      >
        <Tile icon="sliders" tint="gray" size="side" />
        <span className="side-label">Advanced</span>
      </SideButton>
    </nav>
  );
}

function SideButton({
  current,
  onClick,
  value,
  dot = false,
  you = false,
  children,
}: {
  readonly current: boolean;
  readonly onClick: () => void;
  readonly value?: string;
  readonly dot?: boolean;
  readonly you?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={you ? 'side-you' : 'side-item'}
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
      {value === undefined || value === '' ? null : (
        <span className="side-value">{value}</span>
      )}
      {dot ? (
        <span className="side-dot" role="img" aria-label="Needs setup" />
      ) : null}
    </button>
  );
}
