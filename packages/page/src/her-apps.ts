/**
 * Her apps in the settings window: what her page's Apps group, an app's
 * page with the person's account it uses or how it signs in, Get More
 * Apps and an app's file show, from what the daemon last said of her
 * phone and of the App Store's apps for her, and how each read and each
 * answer to the person's act lands in the window. How an app of the App
 * Store stands on her phone is the daemon's word: the page compares no
 * versions. Nothing here touches the DOM.
 */
import type {
  AppInstallOutcome,
  AppPreviewOutcome,
  AppRemoveOutcome,
  AppSignIn,
  AppSource,
  PhoneApp,
  PhoneOutcome,
  RoleModelProvider,
  StoreApp,
  StoreAppStatus,
  StoreOutcome,
} from '@project02/wire/contract';
import type {Option} from './settings-model.ts';
import {
  characterTarget,
  home,
  sectionOf,
  settingsOpened,
  windowPage,
  type OkView,
  type Row,
} from './settings.ts';
import {
  noticed,
  phonePlugin,
  type Settings,
  type SettingsPage,
  type WebState,
} from './store.ts';

/** The App Store, which her phone comes with: there is nothing of it to set. */
const appStore = 'store';
/** The Clock, which her phone comes with. */
const clock = 'clock';

/** What the file chooser offers for an app: its one file, a script. */
export const appFileTypes = '.js,text/javascript';

/** The largest app file: what a text file holds, which the daemon reads no larger. */
const appFileBytes = 256 * 1024;

/**
 * Why the page does not send a chosen file, by its size: none larger than
 * an app file can be is ever sent.
 */
export function appFileRefusal(size: number): string | undefined {
  return size > appFileBytes
    ? 'This file is too large to be an app.'
    : undefined;
}

/** Whether her settings give her a phone, as her view says. */
export function hasPhone(view: OkView): boolean {
  return sectionOf(view, 'plugins', phonePlugin)?.enabled === true;
}

/** Her Ask to Install Apps: the field of her phone's that lets her ask the person to install an app. */
export function askToInstallRow(characterId: string): Row {
  return {
    target: characterTarget(characterId),
    place: {
      kind: 'field',
      namespace: 'plugins',
      id: phonePlugin,
      name: 'askToInstall',
    },
  };
}

/**
 * The home's field of her phone's that holds the person's key for the
 * account `accountId`, as her phone reads it: one for every character.
 */
export function accountKeyRow(accountId: string): Row {
  return {
    target: home,
    place: {
      kind: 'field',
      namespace: 'plugins',
      id: phonePlugin,
      name: `${accountId}ApiKey`,
    },
  };
}

/**
 * The character whose apps a page is about: her page, an app's page of
 * hers, Get More Apps, an app's file for her, and the page of an account
 * opened from an app of hers, whose Back goes to that app.
 */
export function appsCharacterOf(
  page: SettingsPage | undefined,
): string | undefined {
  switch (page?.kind) {
    case 'character':
    case 'remove':
    case 'app':
    case 'get-apps':
    case 'app-file':
      return page.characterId;
    case 'account':
      return page.from?.characterId;
    default:
      return undefined;
  }
}

/** The character whose App Store apps a page shows: Get More Apps, and an app's page, for its update. */
export function catalogCharacterOf(
  page: SettingsPage | undefined,
): string | undefined {
  return page?.kind === 'get-apps' || page?.kind === 'app'
    ? page.characterId
    : undefined;
}

/**
 * What her Apps group shows where its icons are: her apps but the App
 * Store, which has nothing to set; or why her phone could not be read, in
 * the daemon's words.
 */
export type Strip =
  | {readonly kind: 'apps'; readonly apps: readonly PhoneApp[]}
  | {readonly kind: 'unread'; readonly message: string};

/** Her Apps group's icons from her phone as last read; nothing before it was. */
export function stripOf(phone: PhoneOutcome | undefined): Strip | undefined {
  if (phone === undefined) {
    return undefined;
  }

  return phone.status === 'ok'
    ? {kind: 'apps', apps: phone.apps.filter(app => app.id !== appStore)}
    : {kind: 'unread', message: phone.message};
}

/** The line under her Apps group: where apps come from, and, while she may ask, that she finds them and asks first. */
export function appsFooter(mayAsk: boolean): string {
  return mayAsk
    ? 'Apps come from the App Store. She can find them herself, and asks before installing one.'
    : 'Apps come from the App Store.';
}

/** An app's page as it is drawn. */
export type AppShown = {
  readonly app: PhoneApp;
  /** Whose phone it is on, its version and where it came from. */
  readonly line: string;
  /** What Can Wake Her Up says under it, for an app that says it wakes her. */
  readonly wake?: string;
  /** The App Store's newer version of it, which Update gives her. */
  readonly update?: string;
  /** Whether Remove App is offered: not for an app her phone comes with. */
  readonly removable: boolean;
  /** The row of the person's account it uses, for an app that uses one by a key. */
  readonly account?: AccountRow;
  /** How it is signed in, for an app that asks a model through a connection of the person's. */
  readonly signIn?: SignInShown;
};

/**
 * How an app that asks a model is signed in, as its page draws it: each
 * connection of the person's it can sign in with now, as Signed In With
 * offers it; while it is signed in with one of them, that one, with the
 * models it offers in their words and the one it asks; and the line under
 * them. Signed in with a connection no longer connected, it is drawn not
 * signed in, as the design draws it.
 */
export type SignInShown = {
  readonly connections: readonly {
    readonly value: RoleModelProvider;
    /** "Your ChatGPT Plan". */
    readonly label: string;
  }[];
  readonly signedIn?: {
    readonly connection: RoleModelProvider;
    readonly model: string;
    readonly models: readonly Option[];
  };
  readonly line: string;
};

/**
 * The row of the person's account an app uses: the account's name once
 * the person gave her phone its key, else Set Up, either opening the
 * account's page, whose Back returns to the app; and the line under it.
 */
export type AccountRow = {
  readonly name: string;
  readonly hasKey: boolean;
  readonly opens: SettingsPage;
  readonly line: string;
};

const sourceWords: Readonly<Record<AppSource, string>> = {
  built_in: 'built in',
  catalog: 'from the App Store',
  file: 'from a file',
};

/** Her app `appId` as her phone was last read: none while it does not list the app. */
export function herApp(
  settings: Settings,
  characterId: string,
  appId: string,
): PhoneApp | undefined {
  const phone = settings.phones.get(characterId);

  return phone?.status === 'ok'
    ? phone.apps.find(listed => listed.id === appId)
    : undefined;
}

/**
 * The page of her app `appId`, from her phone as last read: none while it
 * does not list the app. Its update is the App Store's word on the app, as
 * the store last said it for her: none when the store could not be read.
 */
export function appShownOf(
  settings: Settings,
  her: {readonly characterId: string; readonly name: string},
  appId: string,
): AppShown | undefined {
  const app = herApp(settings, her.characterId, appId);

  if (app === undefined) {
    return undefined;
  }

  const store = settings.catalogs.get(her.characterId);
  const listed =
    store?.status === 'ok'
      ? store.apps.find(entry => entry.id === appId)
      : undefined;
  const {account, signIn} = app;

  return {
    app,
    line: `On ${her.name}'s phone. Version ${app.version}, ${sourceWords[app.source]}.`,
    ...(app.wakes ? {wake: wakeWords(app)} : {}),
    ...(listed?.status === 'update' ? {update: listed.version} : {}),
    removable: app.source !== 'built_in',
    ...(account === undefined
      ? {}
      : {
          account: {
            name: account.name,
            hasKey: account.hasKey,
            opens: {
              kind: 'account',
              accountId: account.id,
              from: {characterId: her.characterId, appId},
            },
            line: `What she does in it uses your ${account.name} account.`,
          },
        }),
    ...(signIn === undefined ? {} : {signIn: signInShown(signIn, her.name)}),
  };
}

/**
 * How an app that asks a model is signed in on the phone of her, `name`,
 * as its page draws it, from what her phone says of it: its connections
 * and how it is signed in.
 */
function signInShown(
  {connections, signedIn}: AppSignIn,
  name: string,
): SignInShown {
  const offered = connections.map(connection => ({
    value: connection.id,
    label: `Your ${connection.name}`,
  }));
  const connection =
    signedIn === undefined
      ? undefined
      : connections.find(connected => connected.id === signedIn.connection);

  if (signedIn === undefined || connection === undefined) {
    return {
      connections: offered,
      line:
        connections.length === 0
          ? `It needs a ChatGPT plan or an OpenAI API key, connected under AI Model. Then ${name} asks you before she signs in with it.`
          : `${name} asks you the first time she wants to sign in. You can also choose here.`,
    };
  }

  const {model} = signedIn;
  // The model it asks is never hidden, though its connection no longer offers it.
  const unlisted = connection.models.every(offers => offers.id !== model);

  return {
    connections: offered,
    signedIn: {
      connection: connection.id,
      model,
      models: [
        ...connection.models.map(offers => ({
          value: offers.id,
          label: offers.name,
        })),
        ...(unlisted ? [{value: model, label: model}] : []),
      ],
    },
    line:
      connection.id === 'chatgpt'
        ? `Each question she asks uses your ${connection.name}'s limits.`
        : `Each question she asks uses your ${connection.name} account.`,
  };
}

/** What letting an app wake her does: the Clock's alarms and timers, another app's what she sets in it. */
function wakeWords(app: PhoneApp): string {
  return app.id === clock
    ? 'Her alarms and timers can start a moment of her own.'
    : 'What she sets in it can start a moment of her own.';
}

/** How a row of Get More Apps ends: Get and Update give her the app, and Installed says it is on her phone. */
export type RowEnd = 'Get' | 'Update' | 'Installed';

const rowEnds: Readonly<Record<StoreAppStatus, RowEnd>> = {
  not_on_phone: 'Get',
  update: 'Update',
  installed: 'Installed',
};

/** The App Store's apps that the search finds in their names and summaries, every one while it is empty, each with how its row ends. */
export function storeRows(
  apps: readonly StoreApp[],
  search: string,
): readonly {readonly app: StoreApp; readonly end: RowEnd}[] {
  const words = search.trim().toLocaleLowerCase();

  return apps
    .filter(
      app =>
        words === '' ||
        [app.name, app.summary].some(text =>
          text.toLocaleLowerCase().includes(words),
        ),
    )
    .map(app => ({app, end: rowEnds[app.status]}));
}

/** What an app's file would put on her phone, as the daemon previews it. */
export type AppPreview = Extract<AppPreviewOutcome, {status: 'ok'}>;

/** Said of every app from a file, before it is added. */
export const unreadWarning =
  'Nobody at Project02 has read this app. Add it only if it comes from someone you trust.';

/** The version of it on her phone that adding the app replaces, whose data stays; nothing when her phone has none. */
export function replacesLine(preview: AppPreview): string | undefined {
  return preview.replaces === undefined
    ? undefined
    : `This replaces version ${preview.replaces} on her phone. What it kept stays.`;
}

/**
 * Her phone as a read found it. An app's page of hers whose app it does
 * not list, removed here or anywhere, or a phone that could not be read,
 * gives way to her page, which says why.
 */
export function herPhoneRead(
  state: WebState,
  characterId: string,
  outcome: PhoneOutcome,
): WebState {
  const {settings} = state;

  if (settings === undefined) {
    return state;
  }

  const read = {
    ...state,
    settings: {
      ...settings,
      phones: new Map(settings.phones).set(characterId, outcome),
    },
  };
  const page = windowPage(state);
  const gone =
    page?.kind === 'app' &&
    page.characterId === characterId &&
    (outcome.status !== 'ok' ||
      !outcome.apps.some(app => app.id === page.appId));

  return gone ? settingsOpened(read, {kind: 'character', characterId}) : read;
}

/** The App Store's apps for her as a read found them, or why they could not be read. */
export function catalogRead(
  state: WebState,
  characterId: string,
  outcome: StoreOutcome,
): WebState {
  const {settings} = state;

  return settings === undefined
    ? state
    : {
        ...state,
        settings: {
          ...settings,
          catalogs: new Map(settings.catalogs).set(characterId, outcome),
        },
      };
}

/**
 * How giving her an app of the App Store ended, by Get or Update: given,
 * it stands on her phone in the store's version, Installed, and an update
 * of it is offered no more; otherwise the daemon's sentence is a notice.
 */
export function appGiven(
  state: WebState,
  characterId: string,
  appId: string,
  outcome: AppInstallOutcome,
): WebState {
  if (outcome.status !== 'ok') {
    return noticed(state, outcome.message);
  }

  const store = state.settings?.catalogs.get(characterId);

  return store?.status !== 'ok'
    ? state
    : catalogRead(state, characterId, {
        ...store,
        apps: store.apps.map(app =>
          app.id === appId ? {...app, status: 'installed'} : app,
        ),
      });
}

type AppFile = Extract<SettingsPage, {kind: 'app-file'}>;

/**
 * An app's file the person chose for her, and what the daemon said of it:
 * the window shows the offer, keeping the file's text to send again only
 * when it holds an app.
 */
export function appFilePreviewed(
  state: WebState,
  characterId: string,
  file: {readonly name: string; readonly text?: string},
  preview: AppPreviewOutcome,
): WebState {
  return windowPage(state) === undefined
    ? state
    : settingsOpened(state, {
        kind: 'app-file',
        characterId,
        fileName: file.name,
        ...(preview.status === 'ok' && file.text !== undefined
          ? {text: file.text}
          : {}),
        preview,
      });
}

/**
 * How adding the app of the offer `asked` ended, heard by that offer while
 * its file is still the one shown: added, the window opens the app's page
 * and the file goes with the offer; otherwise the offer stays and says
 * why, in the daemon's words. An offer the person has left is not answered
 * in its place: what kept the app out is a notice.
 */
export function appFileAdded(
  state: WebState,
  asked: AppFile,
  outcome: AppInstallOutcome,
): WebState {
  const page = windowPage(state);
  const shown =
    page?.kind === 'app-file' &&
    page.characterId === asked.characterId &&
    page.fileName === asked.fileName &&
    page.text === asked.text
      ? page
      : undefined;

  if (outcome.status === 'ok') {
    return shown === undefined
      ? state
      : settingsOpened(state, {
          kind: 'app',
          characterId: asked.characterId,
          appId: outcome.app.id,
        });
  }

  return shown === undefined
    ? noticed(state, outcome.message)
    : settingsOpened(state, {...shown, problem: outcome.message});
}

/**
 * How removing her app `appId` ended: removed, its page gives way to
 * hers; otherwise its page, still asking, says why in the daemon's words,
 * and once the person has left it, a notice does.
 */
export function appRemoveEnded(
  state: WebState,
  characterId: string,
  appId: string,
  outcome: AppRemoveOutcome,
): WebState {
  const page = windowPage(state);
  const its =
    page?.kind === 'app' &&
    page.characterId === characterId &&
    page.appId === appId
      ? page
      : undefined;

  if (outcome.status === 'ok') {
    return its === undefined
      ? state
      : settingsOpened(state, {kind: 'character', characterId});
  }

  return its?.removing === undefined
    ? noticed(state, outcome.message)
    : settingsOpened(state, {...its, removing: {problem: outcome.message}});
}
