/**
 * What each ask waiting for the person says on the card that asks: the
 * tile of what it is about, who asks, a title and one sentence, where it
 * was raised, and the time it has left. Her ask to install an app is read
 * from its preview here for her phone's window too, which lays it over
 * that app in the store until it is settled. A preview the page cannot
 * read is said as a tool she wants to use, with what it would do behind
 * Details, so nothing the person approves is hidden. Pure, so every
 * sentence is tested in Node.
 */
import type {
  JsonValue,
  PairingRequest,
  PendingConfirmation,
} from '@project02/wire/contract';
import {iconOf, tintOf} from './look.ts';
import {
  artOf,
  choiceWords,
  connectorArt,
  labelOf,
  type Art,
} from './settings-model.ts';
import {sectionOf, valueText, type Field, type OkView} from './settings.ts';
import {webSource} from './store.ts';

/** What the preview of her ask to install an app says it is. */
const installKind = 'phone_app_install';

/** What the preview of her ask to change one of her settings says it is. */
const settingKind = 'runtime_plugin_config_change';

/** The tile of a tool the page knows nothing of. */
const plainArt: Art = {icon: 'grid', tint: 'gray'};

export type InstallAsk = {
  /**
   * The app as the App Store lists it: its id, name, tile and version,
   * whether it says it wakes her, whether it reaches the internet, and the
   * name of the person's account it uses there, when it uses one.
   */
  readonly app: {
    readonly id: string;
    readonly name: string;
    readonly icon: string;
    readonly tint: string;
    readonly version: string;
    readonly wakes: boolean;
    readonly reachesInternet: boolean;
    readonly account?: string;
  };
  /** The version of it on her phone that installing it updates, when there is one. */
  readonly replaces?: string;
};

/** A field's value as her own settings hold it: set, or not. */
type Setting =
  {readonly set: false} | {readonly set: true; readonly value: JsonValue};

/** Her ask to change one field of one of her plugins, from what it was to what it would be. */
export type SettingAsk = {
  readonly pluginId: string;
  readonly fieldName: string;
  readonly before: Setting;
  readonly after: Setting;
};

/** What a card says. */
export type AskWords = {
  /** The tile of what it is about. */
  readonly tile: Art;
  /** The character who asks, whose picture sits on the tile's corner; none when nobody of the home asks. */
  readonly asker?: {readonly id: string; readonly name: string};
  readonly title: string;
  readonly sentence: string;
  /** Where it was raised, when that was not a page: "In Telegram". */
  readonly where?: string;
  /** What it would do, as JSON, behind Details: for a preview the page cannot read. */
  readonly details?: string;
};

type Said = Pick<AskWords, 'tile' | 'title' | 'sentence' | 'details'>;

/** Her ask, when `preview` is one of an app of the App Store that the page can read. */
export function installAskOf(
  preview: Readonly<Record<string, JsonValue>>,
): InstallAsk | undefined {
  const {kind, app, source, replaces} = preview;
  const listed = appOf(app);

  if (
    kind !== installKind ||
    source !== 'catalog' ||
    listed === undefined ||
    (replaces !== undefined && typeof replaces !== 'string')
  ) {
    return undefined;
  }

  return {app: listed, ...(replaces === undefined ? {} : {replaces})};
}

/** Her ask, when `preview` is one of a change of one of her settings that the page can read. */
export function settingAskOf(
  preview: Readonly<Record<string, JsonValue>>,
): SettingAsk | undefined {
  const {kind, targetPluginId, fieldName, before, after} = preview;
  const was = settingOf(before);
  const will = settingOf(after);

  return kind === settingKind &&
    typeof targetPluginId === 'string' &&
    typeof fieldName === 'string' &&
    was !== undefined &&
    will !== undefined
    ? {pluginId: targetPluginId, fieldName, before: was, after: will}
    : undefined;
}

/**
 * A confirmation of the character named `name`: her ask to install or
 * update an app, to change one of her settings, worded as her settings
 * page words it once `settings`, her settings, are read, or else to use a
 * tool.
 */
export function confirmationWords(
  pending: PendingConfirmation,
  name: string,
  settings?: OkView,
): AskWords {
  const {preview} = pending.request;
  const install = installAskOf(preview);
  const setting = settingAskOf(preview);
  const where = whereRaised(pending);
  let said: Said;

  if (install !== undefined) {
    said = installSaid(name, install);
  } else if (setting === undefined) {
    said = toolSaid(name, pending);
  } else {
    said = settingSaid(name, setting, settings);
  }

  return {
    ...said,
    asker: {id: pending.characterId, name},
    ...(where === undefined ? {} : {where}),
  };
}

/** Someone new on a connector, asking to be let in: who, on which, where they wrote and the code. */
export function pairingWords(request: PairingRequest): AskWords {
  return {
    tile: connectorArt(request.connectorId),
    title: `${request.subject.label} wants to pair on ${surfaceName(request.connectorId)}`,
    sentence: `Wrote to ${botOf(request.source)}. Code ${request.code}.`,
  };
}

/**
 * The time from `now` until `at`, as the card counts it down each second:
 * minutes and seconds, and hours too past an hour. A second begun is a
 * second left, so it reads 0:00 when the time is up.
 */
export function timeLeft(at: number, now: number): string {
  const left = Math.max(0, Math.ceil((at - now) / 1000));
  const seconds = String(left % 60).padStart(2, '0');
  const minutes = Math.floor(left / 60) % 60;
  const hours = Math.floor(left / 3600);

  return hours === 0
    ? `${String(minutes)}:${seconds}`
    : `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}`;
}

function installSaid(name: string, {app, replaces}: InstallAsk): Said {
  return {
    tile: {icon: iconOf(app.icon), tint: tintOf(app.tint)},
    title: `${name} wants to ${replaces === undefined ? 'install' : 'update'} ${app.name}`,
    sentence:
      replaces === undefined
        ? `From the App Store. It ${joined(mayDo(app))}.`
        : `From the App Store. Version ${app.version} replaces ${replaces}, and what it kept stays.`,
  };
}

/** What an app may do, a clause each: keeping its own data is every app's. */
function mayDo(app: InstallAsk['app']): readonly string[] {
  return [
    'keeps its own data',
    ...(app.wakes ? ['can wake her up'] : []),
    ...(app.reachesInternet ? ['reaches the internet'] : []),
    ...(app.account === undefined ? [] : [`uses your ${app.account} account`]),
  ];
}

/** Clauses joined as a sentence joins them: the last by "and", the rest by commas. */
function joined(clauses: readonly string[]): string {
  const last = clauses.at(-1) ?? '';

  return clauses.length < 2
    ? last
    : `${clauses.slice(0, -1).join(', ')} and ${last}`;
}

/**
 * The feature by its name on her settings page, the field and each value
 * in the words that page shows them in. Until her settings are read, or
 * should they not list it, the preview's own names say it.
 */
function settingSaid(
  name: string,
  ask: SettingAsk,
  settings: OkView | undefined,
): Said {
  const section =
    settings === undefined
      ? undefined
      : sectionOf(settings, 'plugins', ask.pluginId);
  const field = section?.fields.find(
    candidate => candidate.name === ask.fieldName,
  );

  return {
    tile: section === undefined ? plainArt : artOf(section),
    title: `${name} wants to change her ${section?.displayName ?? ask.pluginId}`,
    sentence: closed(
      `${field === undefined ? ask.fieldName : labelOf(field)}: ${settingWords(ask.before, field)} → ${settingWords(ask.after, field)}`,
    ),
  };
}

/** A tool's call the page cannot read: the tool, what it says it does, and the call itself behind Details. */
function toolSaid(name: string, {request}: PendingConfirmation): Said {
  return {
    tile: plainArt,
    title: `${name} wants to use ${request.toolName}`,
    sentence: request.summary,
    details: JSON.stringify(request.preview, null, 2),
  };
}

/** A value as her settings page shows it: a choice in its words, anything else as its box holds it. */
function settingWords(setting: Setting, field: Field | undefined): string {
  if (!setting.set) {
    return 'not set';
  }

  const {value} = setting;

  return field !== undefined && typeof value === 'string'
    ? choiceWords(field, value)
    : valueText(value);
}

/** Words that end a sentence end it; any others get its full stop. */
function closed(words: string): string {
  return /[.!?…]$/u.test(words) ? words : `${words}.`;
}

/** The surface a line of the turn that raised it came from, when it was not a page: by its name, as a person says it. */
function whereRaised({turn}: PendingConfirmation): string | undefined {
  if (turn === undefined || turn.source === webSource) {
    return undefined;
  }

  const [surface = turn.source] = turn.source.split(':');

  return `In ${surfaceName(surface)}`;
}

/** `telegram` → `Telegram`: a surface named as a person reads it. */
function surfaceName(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** The bot the account wrote to, by its @ name: the source is `telegram:<bot username>`. */
function botOf(source: string): string {
  return `@${source.slice(source.indexOf(':') + 1)}`;
}

/** The app of an install's preview, when every fact of it the page reads is there. */
function appOf(app: JsonValue | undefined): InstallAsk['app'] | undefined {
  if (!isFields(app)) {
    return undefined;
  }

  const {id, name, icon, tint, version, wakes, reachesInternet, account} = app;

  return typeof id === 'string' &&
    typeof name === 'string' &&
    typeof icon === 'string' &&
    typeof tint === 'string' &&
    typeof version === 'string' &&
    typeof wakes === 'boolean' &&
    typeof reachesInternet === 'boolean' &&
    (account === undefined || typeof account === 'string')
    ? {
        id,
        name,
        icon,
        tint,
        version,
        wakes,
        reachesInternet,
        ...(account === undefined ? {} : {account}),
      }
    : undefined;
}

/** A field's value before or after the change, as the preview says it: `configured`, and its value when it is. */
function settingOf(authored: JsonValue | undefined): Setting | undefined {
  if (!isFields(authored)) {
    return undefined;
  }

  const {configured, value} = authored;

  if (configured === false) {
    return {set: false};
  }

  return configured === true && value !== undefined
    ? {set: true, value}
    : undefined;
}

function isFields(
  value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
