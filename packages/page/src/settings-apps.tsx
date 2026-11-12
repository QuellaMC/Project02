/**
 * Her apps in the settings window, as the approved design draws them: the
 * Apps group on her page, an app's page, Get More Apps, and an app from a
 * file. Each draws what the daemon last said of her phone and of the App
 * Store's apps for her, as the rules of her apps work it out, and every
 * act goes to the session.
 */
import {useState, type ReactNode} from 'react';

import type {AppSignInBody} from '@project02/wire/contract';
import {
  appFileTypes,
  appShownOf,
  appsFooter,
  askToInstallRow,
  hasPhone,
  replacesLine,
  storeRows,
  stripOf,
  unreadWarning,
  type AccountRow,
  type SignInShown,
} from './her-apps.ts';
import {iconOf, tintOf} from './look.ts';
import {
  Cell,
  Chevron,
  FileButton,
  Group,
  Icon,
  Label,
  PageHeader,
  SelectBox,
  SubHeader,
  Switch,
  Tile,
} from './settings-controls.tsx';
import type {Ctx} from './settings-fields.tsx';
import {valueNow} from './settings-model.ts';
import {fieldAt, type OkView} from './settings.ts';
import {characterName, type SettingsPage} from './store.ts';

type AppPageShown = Extract<SettingsPage, {kind: 'app'}>;

/**
 * Her Apps group, while her settings give her a phone: an icon for each
 * app on it but the App Store, each opening its page, or why her phone
 * could not be read; Get More Apps; and where apps come from.
 */
export function HerApps({
  ctx,
  characterId,
  view,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
  readonly view: OkView;
}) {
  const {settings, session} = ctx;

  if (!hasPhone(view)) {
    return null;
  }

  const strip = stripOf(settings.phones.get(characterId));
  const ask = askToInstallRow(characterId);
  const field = fieldAt(view, ask.place);
  const mayAsk =
    field !== undefined && valueNow(settings, ask, field) === 'true';

  return (
    <Group title="Apps" footer={appsFooter(mayAsk)}>
      {strip?.kind === 'unread' ? (
        <p className="panel-empty panel-problem">{strip.message}</p>
      ) : strip === undefined || strip.apps.length === 0 ? null : (
        <div className="app-strip">
          {strip.apps.map(app => (
            <button
              key={app.id}
              type="button"
              className="app-strip-app"
              onClick={() => {
                session.goTo({kind: 'app', characterId, appId: app.id});
              }}
            >
              <Tile
                icon={iconOf(app.icon)}
                tint={tintOf(app.tint)}
                size="app"
              />
              <span className="app-strip-name">{app.name}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="cell cell-link"
        onClick={() => {
          session.goTo({kind: 'get-apps', characterId});
        }}
      >
        <span className="line line-plain">
          <Tile icon="plus" tint="blue" />
          <span className="label value-link">Get More Apps</span>
        </span>
      </button>
    </Group>
  );
}

/**
 * An app's page under hers: its tile and name, with whose phone it is on,
 * its version and where it came from; Update Available while the App
 * Store has a newer version; what it may do; Can Wake Her Up for an app
 * that says it wakes her; the person's account it uses, for one that uses
 * one by a key, or how it is signed in, for one that asks a model; and
 * Remove App for one her phone does not come with.
 */
export function AppPage({
  ctx,
  page,
}: {
  readonly ctx: Ctx;
  readonly page: AppPageShown;
}) {
  const {state, settings, session} = ctx;
  const {characterId} = page;
  const name = characterName(state, characterId);
  const shown = appShownOf(settings, {characterId, name}, page.appId);

  if (shown === undefined) {
    return null;
  }

  const {app} = shown;

  return (
    <>
      <SubHeader
        back={name}
        onBack={() => {
          session.goTo({kind: 'character', characterId});
        }}
        title={app.name}
        blurb={app.summary}
      />
      <Group footer={shown.line}>
        <Cell>
          <Tile icon={iconOf(app.icon)} tint={tintOf(app.tint)} />
          <Label name={app.name} />
        </Cell>
      </Group>
      {shown.update === undefined ? null : (
        <Group>
          <Cell kind="tall">
            <Tile icon="download" tint="blue" />
            <Label
              name="Update Available"
              detail={`Version ${shown.update}`}
              strong
            />
            <ActionButton
              className="button-small button-filled"
              label={`Update ${app.name}`}
              act={() => session.giveApp(characterId, app.id)}
            >
              Update
            </ActionButton>
          </Cell>
        </Group>
      )}
      <ItMay lines={app.itMay} />
      {shown.wake === undefined ? null : (
        <Group footer={shown.wake}>
          <Cell kind="switch">
            <Label name="Can Wake Her Up" />
            <Switch
              on={app.mayWake}
              label="Can Wake Her Up"
              onToggle={() => {
                void session.letAppWake(characterId, app.id, !app.mayWake);
              }}
            />
          </Cell>
        </Group>
      )}
      {shown.account === undefined ? null : (
        <AccountGroup ctx={ctx} account={shown.account} />
      )}
      {shown.signIn === undefined ? null : (
        <SignInGroup ctx={ctx} page={page} signIn={shown.signIn} />
      )}
      {shown.removable ? (
        <RemoveApp ctx={ctx} page={page} app={app.name} her={name} />
      ) : null}
    </>
  );
}

/** What an app may do, a line each on a shield, as its page and the preview of its file list them. */
function ItMay({lines}: {readonly lines: readonly string[]}) {
  return (
    <Group title="It May">
      {lines.map(line => (
        <Cell kind="note" key={line}>
          <Tile icon="shield" tint="gray" size="note" />
          <span className="label">{line}</span>
        </Cell>
      ))}
    </Group>
  );
}

/**
 * The person's account an app uses: its name with a chevron once its key
 * is set, else Set Up, either opening the account's page; and under it,
 * that what she does in the app uses the account.
 */
function AccountGroup({
  ctx,
  account,
}: {
  readonly ctx: Ctx;
  readonly account: AccountRow;
}) {
  const open = () => {
    ctx.session.goTo(account.opens);
  };

  return (
    <Group footer={account.line}>
      <Cell kind="switch">
        <Label name="Account" />
        {account.hasKey ? (
          <button type="button" className="drill" onClick={open}>
            {account.name}
            <Chevron />
          </button>
        ) : (
          <button type="button" className="button-setup" onClick={open}>
            Set Up
          </button>
        )}
      </Cell>
    </Group>
  );
}

/**
 * How an app that asks a model is signed in, as the design draws it:
 * Signed In With, Not Signed In or a connection of the person's it can
 * sign in with now, and, while it is signed in, the model it asks, each
 * saved at the choice; and under them, what that means.
 */
function SignInGroup({
  ctx,
  page,
  signIn,
}: {
  readonly ctx: Ctx;
  readonly page: AppPageShown;
  readonly signIn: SignInShown;
}) {
  const {characterId, appId} = page;
  const {signedIn} = signIn;
  const [connection, chooseConnection] = useChoice(signedIn?.connection ?? '');
  const [model, chooseModel] = useChoice(signedIn?.model ?? '');
  const signInWith = (body: AppSignInBody): Promise<boolean> =>
    ctx.session.signInApp(characterId, appId, body);

  return (
    <Group footer={signIn.line}>
      <Cell kind="field">
        <label htmlFor="sign-in-connection" className="field-label">
          Signed In With
        </label>
        <SelectBox
          id="sign-in-connection"
          value={connection}
          options={signIn.connections}
          none="Not Signed In"
          onChoose={value => {
            const chosen = signIn.connections.find(
              offered => offered.value === value,
            );

            chooseConnection(
              chosen?.value ?? '',
              signInWith(
                chosen === undefined ? {} : {connection: chosen.value},
              ),
            );
          }}
        />
      </Cell>
      {signedIn === undefined ? null : (
        <Cell kind="field">
          <label htmlFor="sign-in-model" className="field-label">
            Model
          </label>
          <SelectBox
            id="sign-in-model"
            value={model}
            options={signedIn.models}
            onChoose={value => {
              if (value !== undefined) {
                chooseModel(
                  value,
                  signInWith({connection: signedIn.connection, model: value}),
                );
              }
            }}
          />
        </Cell>
      )}
    </Group>
  );
}

/**
 * What a select of her phone's says while the choice made in it is on its
 * way: the choice, until her phone says other than it said when the
 * choice was made, or her phone did not keep it; then what her phone
 * says, `shown`. So the select never goes back through what it said
 * before.
 */
function useChoice(
  shown: string,
): readonly [string, (chosen: string, kept: Promise<boolean>) => void] {
  const [choice, setChoice] = useState<{
    readonly over: string;
    readonly chosen: string;
  }>();

  if (choice !== undefined && choice.over !== shown) {
    setChoice(undefined);
  }

  return [
    choice?.chosen ?? shown,
    (chosen, kept) => {
      setChoice({over: shown, chosen});
      void kept.then(taken => {
        if (!taken) {
          setChoice(undefined);
        }
      });
    },
  ];
}

/**
 * Remove App, at the bottom of the page of an app she did not come with.
 * It asks first, as removing a character does, saying that what the app
 * kept goes with it, the focus on Cancel; and says in the daemon's words
 * why the app was not removed when it was not.
 */
function RemoveApp({
  ctx,
  page,
  app,
  her,
}: {
  readonly ctx: Ctx;
  readonly page: AppPageShown;
  readonly app: string;
  readonly her: string;
}) {
  const {session} = ctx;
  const {characterId, appId, removing} = page;

  if (removing === undefined) {
    return (
      <button
        type="button"
        className="button-danger"
        onClick={() => {
          session.goTo({...page, removing: {}});
        }}
      >
        Remove App…
      </button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-labelledby="remove-app-title"
      aria-describedby="remove-app-text"
      className="confirm"
    >
      <div className="confirm-words">
        <span id="remove-app-title" className="confirm-title">
          Remove {app}?
        </span>
        <span id="remove-app-text" className="page-note">
          It leaves {her}&apos;s phone, and everything it kept is deleted with
          it.
        </span>
      </div>
      <div className="confirm-buttons">
        <button
          type="button"
          className="button-pill button-destructive"
          onClick={() => {
            void session.removeApp(characterId, appId);
          }}
        >
          Remove
        </button>
        <button
          type="button"
          className="button-pill"
          autoFocus
          onClick={() => {
            session.goTo({kind: 'app', characterId, appId});
          }}
        >
          Cancel
        </button>
      </div>
      {removing.problem === undefined ? null : (
        <p className="page-problem" role="alert">
          {removing.problem}
        </p>
      )}
    </div>
  );
}

/**
 * Get More Apps: the App Store's apps for her, which a search narrows by
 * their names and summaries, each row ending in Get, Update or Installed,
 * or the daemon's sentence in their place when they could not be read;
 * then an app from a file, which nobody read.
 */
export function GetAppsPage({
  ctx,
  characterId,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
}) {
  const {state, settings, session} = ctx;
  const [search, setSearch] = useState('');
  const store = settings.catalogs.get(characterId);

  return (
    <>
      <SubHeader
        back={characterName(state, characterId)}
        onBack={() => {
          session.goTo({kind: 'character', characterId});
        }}
        title="Get More Apps"
      />
      <span className="search">
        <Icon name="magnifier" size={16} weight={2} className="search-glass" />
        <input
          type="search"
          className="input search-input"
          aria-label="Search Apps"
          placeholder="Search Apps"
          value={search}
          onChange={event => {
            setSearch(event.currentTarget.value);
          }}
        />
      </span>
      {store === undefined ? null : store.status === 'ok' ? (
        <StoreRows
          ctx={ctx}
          characterId={characterId}
          rows={storeRows(store.apps, search)}
          search={search}
        />
      ) : (
        <p className="page-problem">{store.message}</p>
      )}
      <Group>
        <FileButton
          className="cell cell-link"
          accept={appFileTypes}
          onChoose={file => {
            void session.chooseAppFile(characterId, file);
          }}
        >
          <span className="line line-plain line-plain-tall">
            <Tile icon="doc" tint="blue" />
            <Label
              name="From a File"
              detail="An app someone shared with you"
              strong
            />
            <Chevron />
          </span>
        </FileButton>
      </Group>
    </>
  );
}

/** The App Store's apps the search finds: each its tile, its name and summary, and Get, Update or Installed; or that none matches. */
function StoreRows({
  ctx,
  characterId,
  rows,
  search,
}: {
  readonly ctx: Ctx;
  readonly characterId: string;
  readonly rows: ReturnType<typeof storeRows>;
  readonly search: string;
}) {
  if (rows.length === 0) {
    return search.trim() === '' ? null : (
      <p className="page-note">Nothing matches “{search.trim()}”.</p>
    );
  }

  return (
    <Group title="Reviewed by Project02">
      {rows.map(({app, end}) => (
        <Cell kind="tall" key={app.id}>
          <Tile icon={iconOf(app.icon)} tint={tintOf(app.tint)} />
          <Label name={app.name} detail={app.summary} />
          {end === 'Installed' ? (
            <span className="value">Installed</span>
          ) : (
            <ActionButton
              className="button-small button-blue"
              label={`${end} ${app.name}`}
              act={() => ctx.session.giveApp(characterId, app.id)}
            >
              {end}
            </ActionButton>
          )}
        </Cell>
      ))}
    </Group>
  );
}

/** A button that rests while what it asked for is on its way. */
function ActionButton({
  className,
  label,
  act,
  children,
}: {
  readonly className: string;
  readonly label: string;
  readonly act: () => Promise<void>;
  readonly children: ReactNode;
}) {
  const [acting, setActing] = useState(false);
  const click = async () => {
    setActing(true);
    await act();
    setActing(false);
  };

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      disabled={acting}
      onClick={() => {
        void click();
      }}
    >
      {children}
    </button>
  );
}

/**
 * An app's file the person chose for her: what the app is and may do,
 * the version on her phone it replaces, and that nobody read it, as the
 * daemon previews it; or why the file holds no app. Add gives it to her
 * and opens its page; Cancel goes back to Get More Apps.
 */
export function AppFilePage({
  ctx,
  page,
}: {
  readonly ctx: Ctx;
  readonly page: Extract<SettingsPage, {kind: 'app-file'}>;
}) {
  const {session} = ctx;
  const {characterId, preview} = page;
  const cancel = (
    <button
      type="button"
      className="button-large"
      onClick={() => {
        session.goTo({kind: 'get-apps', characterId});
      }}
    >
      Cancel
    </button>
  );

  if (preview.status !== 'ok') {
    return (
      <>
        <div className="preview-top">
          <PageHeader
            art={<Tile icon="doc" tint="gray" size="page" />}
            title={page.fileName}
          />
        </div>
        <p className="page-problem" role="alert">
          {preview.message}
        </p>
        <div className="actions">
          <FileButton
            className="button-large button-default"
            accept={appFileTypes}
            onChoose={file => {
              void session.chooseAppFile(characterId, file);
            }}
          >
            Choose Another File
          </FileButton>
          {cancel}
        </div>
      </>
    );
  }

  const replaces = replacesLine(preview);

  return (
    <>
      <div className="preview-top">
        <PageHeader
          art={
            <Tile
              icon={iconOf(preview.icon)}
              tint={tintOf(preview.tint)}
              size="page"
            />
          }
          title={preview.name}
          subtitle={`Version ${preview.version} · ${page.fileName}`}
        />
        <p className="preview-about">{preview.summary}</p>
      </div>
      <ItMay lines={preview.itMay} />
      {replaces === undefined ? null : <p className="page-note">{replaces}</p>}
      <p className="app-warning">{unreadWarning}</p>
      <div className="preview-end">
        <div className="actions">
          <button
            type="button"
            className="button-large button-default"
            onClick={() => {
              void session.addAppFile();
            }}
          >
            Add
          </button>
          {cancel}
        </div>
        {page.problem === undefined ? null : (
          <p className="page-problem" role="alert">
            {page.problem}
          </p>
        )}
      </div>
    </>
  );
}
