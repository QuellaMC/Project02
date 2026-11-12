/**
 * What each page of the settings window shows, worked out from the views,
 * health and what is typed: which rows a card draws, which control a row
 * takes, the words a value is said in, the sidebar's values and dots, and
 * where each finding is said. The components draw what these say and
 * decide nothing of their own. Nothing here touches the DOM.
 */
import type {
  AccessName,
  CharacterFeature,
  CharacterPreviewOutcome,
  CharacterSummary,
  ConfigTarget,
  GatewayHealth,
  LayoutWhen,
  Placement,
  RuntimeConfigDiagnostic,
  RuntimeConfigSectionNamespace,
} from '@project02/wire/contract';
import {iconOf, tintOf, type IconName, type Tint} from './look.ts';
import {
  characterTarget,
  fieldAt,
  home,
  rowKey,
  sectionKey,
  sectionOf,
  targetKey,
  targetOfKey,
  valueText,
  viewOf,
  type Field,
  type OkView,
  type Row,
  type Section,
} from './settings.ts';
import type {Settings, SettingsPage} from './store.ts';

/** How a row changes its field. */
export type Control = 'key' | 'switch' | 'segmented' | 'pills' | 'text';

/**
 * A secret is typed into a key box, a boolean is a switch, and a choice is
 * a segmented control while its words fit one, three at most, and a row of
 * pills under its label beyond that. Everything else is a text box.
 */
export function controlOf(field: Field): Control {
  if (field.secret) {
    return 'key';
  }

  if (field.valueType === 'boolean') {
    return 'switch';
  }

  if (field.allowedValues !== undefined) {
    return field.allowedValues.length <= 3 ? 'segmented' : 'pills';
  }

  return 'text';
}

/** What a page calls a field: its label, or its name when it declares none. */
export function labelOf(field: Field): string {
  return field.label ?? field.name;
}

/** The words a choice is said in: its declared words, else the value itself. */
export function choiceWords(field: Field, value: string): string {
  return field.choices?.[value] ?? value;
}

/**
 * The field's value in effect as the row shows it now: what was clicked or
 * typed there and not yet landed, else the view's.
 */
export function valueNow(
  settings: Settings,
  row: Row,
  field: Field,
): string | undefined {
  const edit = settings.edits.get(rowKey(row));
  const value = field.effective.value;

  if (edit !== undefined) {
    return edit === '' ? undefined : edit;
  }

  return value === undefined ? undefined : valueText(value);
}

/** Whether a switch is on: what was just clicked, else the view's. */
export function switchedOn(
  settings: Settings,
  target: ConfigTarget,
  section: Section,
): boolean {
  const edit = settings.edits.get(
    rowKey({
      target,
      place: {kind: 'switch', namespace: section.namespace, id: section.id},
    }),
  );

  return edit === undefined ? section.enabled : edit === 'true';
}

/**
 * What a box shows when it is empty. A character's box shows what she
 * takes from the home when she sets nothing of her own; the home's shows
 * the field's own hint, else its default.
 */
export function placeholderOf(field: Field, target: ConfigTarget): string {
  const value = field.effective.value;
  const inherited =
    field.authored.configured || field.secret || value === undefined
      ? undefined
      : valueText(value);

  return (
    (target.scope === 'character'
      ? (inherited ?? field.placeholder)
      : (field.placeholder ?? inherited)) ?? ''
  );
}

/** A key box is always empty: a stored key shows as dots, and as an invitation while the box is focused. */
export function keyPlaceholder(field: Field, focused: boolean): string {
  if (!field.authored.configured) {
    return field.placeholder ?? 'Paste key';
  }

  return focused ? 'Paste a new key' : '••••••••••••';
}

/** A card of a section as a page draws it: the fields it shows. */
export type ShownCard = {
  readonly title?: string;
  readonly footer?: string;
  readonly fields: readonly Field[];
};

/**
 * The cards of a section as a page draws them, by the window's two rules.
 * A value in effect is never hidden: `when` hides a card or a row only
 * while the field it names holds a value outside `is`, when what it hides
 * has no effect; and an advanced card hides a row only while the Advanced
 * switch is off and its field holds no value of its own. A row with a
 * finding at it shows whatever the rules say. A card left with no row to
 * show is not drawn.
 */
export function cardsShown(
  section: Section,
  rules: {
    readonly advanced: boolean;
    /** The value in effect of a field of the section, as the page shows it now. */
    readonly current: (name: string) => string | undefined;
    /** Whether something is said at a field of the section. */
    readonly said: (name: string) => boolean;
  },
): readonly ShownCard[] {
  const holds = (when: LayoutWhen | undefined): boolean => {
    if (when === undefined) {
      return true;
    }

    const value = rules.current(when.field);

    return value === undefined || when.is.includes(value);
  };

  return section.layout.flatMap(card => {
    const fields = card.rows.flatMap(row => {
      const field = section.fields.find(
        candidate => candidate.name === row.field,
      );
      const shown =
        field !== undefined &&
        (rules.said(field.name) ||
          (holds(card.when) &&
            holds(row.when) &&
            (!card.advanced || rules.advanced || field.authored.configured)));

      return shown ? [field] : [];
    });

    return fields.length === 0
      ? []
      : [
          {
            ...(card.title === undefined ? {} : {title: card.title}),
            ...(card.footer === undefined ? {} : {footer: card.footer}),
            fields,
          },
        ];
  });
}

/**
 * What a feature's value says, on her page and as its entry: off, or the
 * words of its first row's choice, or on when that row is not a choice or
 * holds none.
 */
export function featureValue(
  section: Section,
  on: boolean,
  current: (name: string) => string | undefined,
): string {
  if (!on) {
    return 'Off';
  }

  const first = section.fields.find(
    field => field.name === section.layout[0]?.rows[0]?.field,
  );
  const value = first === undefined ? undefined : current(first.name);

  return first?.allowedValues === undefined || value === undefined
    ? 'On'
    : choiceWords(first, value);
}

/** How a plugin's row on her page is changed. */
export type FeatureControl = 'setup' | 'drill' | 'switch';

/**
 * A plugin whose setup is not finished offers to set it up; one whose
 * fields her view lists opens its own page for her; any other is a switch,
 * her own.
 */
export function featureControl(section: Section): FeatureControl {
  if (!section.setup.ready) {
    return 'setup';
  }

  return section.fields.length > 0 ? 'drill' : 'switch';
}

/** Her view's plugins placed so, in their order and then by name. */
export function featuresPlaced(
  view: OkView,
  placement: Placement,
): readonly Section[] {
  return view.sections
    .filter(section => section.page?.placement === placement)
    .toSorted(
      (left, right) =>
        (left.page?.order ?? 0) - (right.page?.order ?? 0) ||
        left.displayName.localeCompare(right.displayName),
    );
}

/** The plugins whose home settings are an account set up once, each an entry among the connections: those that say they are one. */
function connections(view: OkView | undefined): readonly Section[] {
  return (view?.sections ?? []).filter(isConnection);
}

function isConnection(section: Section): boolean {
  return (
    section.namespace === 'plugins' && section.page?.connection !== undefined
  );
}

function hasConnection(settings: Settings, pluginId: string): boolean {
  return connections(viewOf(settings, home)).some(
    section => section.id === pluginId,
  );
}

/** Where a plugin's setup is finished: its connection, else its own page. */
export function setupPage(settings: Settings, pluginId: string): SettingsPage {
  return hasConnection(settings, pluginId)
    ? {kind: 'connection', pluginId}
    : {kind: 'plugin', namespace: 'plugins', id: pluginId};
}

/** How a character is said to stand on her page. */
export type CharacterStatus = {
  readonly word: string;
  readonly tone: 'off' | 'ready' | 'warn' | 'problem' | 'busy';
  /** What she says of herself, under her header. */
  readonly note?: string;
  /** Whether what she lacks is an AI model, which the line opens. */
  readonly model: boolean;
};

const stateWords: Readonly<Record<CharacterSummary['state'], string>> = {
  not_started: 'Not Started',
  starting: 'Starting',
  ready: 'Ready',
  needs_model: 'Needs an AI model',
  stopping: 'Stopping',
  stopped: 'Stopped',
  failed: "Can't Start",
};

/**
 * Off when her switch is; needing an AI model when she does or her view
 * gives her none, with what to do; and otherwise her state in a word, with
 * her note when she carries one: why she failed, or what she warns of.
 */
export function characterStatus(
  character: CharacterSummary,
  view: OkView | undefined,
): CharacterStatus {
  if (!character.enabled) {
    return {word: 'Off', tone: 'off', model: false};
  }

  const needsModel =
    character.state === 'needs_model' || view?.model.ready === false;
  const note = needsModel
    ? (character.diagnostic ?? view?.model.message)
    : character.diagnostic;
  const tone = needsModel
    ? 'warn'
    : character.state === 'ready'
      ? 'ready'
      : character.state === 'failed'
        ? 'problem'
        : 'busy';

  return {
    word: stateWords[needsModel ? 'needs_model' : character.state],
    tone,
    model: needsModel,
    ...(note === undefined ? {} : {note}),
  };
}

/** What a bot's row says of it, and the sentence its page adds when it is a problem. */
export type BotWords = {
  readonly value: string;
  readonly tone: 'link' | 'plain' | 'problem';
  readonly sentence?: string;
};

/** Said on the Telegram page and a bot's while the connector is off the daemon's stream. */
export const telegramNotRunning =
  "Telegram isn't running. The app starts it; at a terminal, run project02 telegram.";

const botProblems = {
  refused: {
    value: 'Token Refused',
    sentence:
      "Telegram didn't accept this token. Remove the bot and paste the token @BotFather gave you.",
  },
  unreachable: {
    value: "Can't Reach Telegram",
    sentence: "Telegram can't be reached right now. It tries again by itself.",
  },
  conflict: {
    value: 'In Use Elsewhere',
    sentence:
      'Another program is using this bot. Stop it there, or make a new bot with @BotFather.',
  },
  webhook: {
    value: 'Set to a Webhook',
    sentence:
      'This bot sends its messages to a web address, so they never arrive here. Make a new bot with @BotFather and use its token.',
  },
} as const;

/**
 * A bot as health says it stands: to be added while no token is stored;
 * its name once Telegram said who it is; the problem in a few words, with
 * what to do on its page; and connecting until the connector says.
 */
export function botWords(
  health: GatewayHealth | undefined,
  target: ConfigTarget,
  stored: boolean,
): BotWords {
  if (!stored) {
    return {value: 'Add', tone: 'link'};
  }

  const telegram = health?.connectors.find(
    connector => connector.id === 'telegram',
  );

  if (telegram?.connected !== true) {
    return {value: 'Not Running', tone: 'plain', sentence: telegramNotRunning};
  }

  const bot = telegram.bots.find(
    entry => targetKey(entry.target) === targetKey(target),
  );

  if (bot === undefined) {
    return {value: 'Connecting…', tone: 'plain'};
  }

  if (bot.state === 'on') {
    return {
      value: bot.username === undefined ? 'On' : `@${bot.username}`,
      tone: 'plain',
    };
  }

  return {...botProblems[bot.state], tone: 'problem'};
}

/** Whether the target's own settings hold a bot token, the home's own bot or a character's. */
export function botStored(settings: Settings, target: ConfigTarget): boolean {
  const view = viewOf(settings, target);
  const field =
    view === undefined
      ? undefined
      : fieldAt(view, {
          kind: 'field',
          namespace: 'connectors',
          id: 'telegram',
          name: target.scope === 'global' ? 'managementBotToken' : 'botToken',
        });

  return field?.authored.configured === true;
}

/** Whether Telegram is switched on: the home's switch. */
export function telegramOn(settings: Settings): boolean {
  const view = viewOf(settings, home);

  return (
    view !== undefined &&
    sectionOf(view, 'connectors', 'telegram')?.enabled === true
  );
}

/** Every section of the views, plugins and connectors, once each: the plugins by where they sit and their order, then the connectors. */
export function sectionsListed(settings: Settings): readonly Section[] {
  const listed = new Map<string, Section>();

  for (const view of settings.views.values()) {
    for (const section of view.status === 'ok' ? view.sections : []) {
      const key = sectionKey(section.namespace, section.id);

      if (!listed.has(key)) {
        listed.set(key, section);
      }
    }
  }

  const rank = (section: Section): number =>
    section.namespace === 'connectors'
      ? 2
      : section.page?.placement === 'permission'
        ? 1
        : 0;

  return [...listed.values()].toSorted(
    (left, right) =>
      rank(left) - rank(right) ||
      (left.page?.order ?? 0) - (right.page?.order ?? 0) ||
      left.displayName.localeCompare(right.displayName),
  );
}

/** The characters whose view runs the section. */
export function usedBy(
  settings: Settings,
  characters: readonly CharacterSummary[],
  namespace: RuntimeConfigSectionNamespace,
  id: string,
): readonly CharacterSummary[] {
  return characters.filter(character => {
    const view = viewOf(settings, characterTarget(character.id));

    return (
      view !== undefined &&
      sectionOf(view, namespace, id)?.activation.status === 'active'
    );
  });
}

/** Each access a plugin can ask for, in the order a person cares about, worded for each level. */
const accessWords: readonly (readonly [
  AccessName,
  {readonly read: string; readonly write: string},
])[] = [
  [
    'network',
    {
      read: 'Sends your chats to the service you set up for it',
      write: 'Sends your chats to the service you set up for it',
    },
  ],
  [
    'session_history',
    {read: 'Reads your chats with her', write: 'Changes your chats with her'},
  ],
  [
    'turn_context',
    {
      read: 'Sees each message you send her',
      write: 'Changes the messages you send her',
    },
  ],
  [
    'character_file_store',
    {read: 'Reads her own files', write: 'Keeps things in her own files'},
  ],
  [
    'plugin_database',
    {read: 'Reads its own records', write: 'Keeps its own records'},
  ],
  [
    'model_input',
    {read: 'Sees what she is told', write: 'Adds to what she knows'},
  ],
  [
    'trusted_context',
    {read: 'Sees the notes she trusts', write: 'Adds notes she trusts'},
  ],
];

/** What a plugin can do, a line for each access it asks for; a connector sends and receives its messages. */
export function accessLines(section: Section): readonly string[] {
  if (section.namespace === 'connectors') {
    return [`Sends and receives ${section.displayName} messages`];
  }

  return accessWords.flatMap(([name, words]) => {
    const level = section.access?.[name];

    return level === undefined || level === 'none' ? [] : [words[level]];
  });
}

/** Where each finding of the views is said. */
export type Findings = {
  /** Row key → an error at the value there. */
  readonly rows: ReadonlyMap<string, readonly string[]>;
  /** Section key, its target's and then `<namespace>/<id>` → an error about the section as a whole. */
  readonly sections: ReadonlyMap<string, readonly string[]>;
  /** Everything else, once each: warnings, and errors about the settings as a whole. */
  readonly notes: readonly string[];
};

/**
 * Every finding of the views, once, at the place it concerns. A finding
 * belongs to the document it was made in: a character's overlay, or the
 * home's, which every character's view shows too. An error at a field is
 * said at that field and one about a section on that section's page;
 * everything else is a note, a character's named.
 */
export function findings(
  settings: Settings,
  nameOf: (characterId: string) => string,
): Findings {
  const homeView = viewOf(settings, home);
  const fromHome = new Set(homeView?.diagnostics.map(identity));
  const said = new Set<string>();
  const rows = new Map<string, string[]>();
  const sections = new Map<string, string[]>();
  const notes: string[] = [];
  const add = (into: Map<string, string[]>, key: string, message: string) => {
    into.set(key, [...(into.get(key) ?? []), message]);
  };

  for (const [key, view] of settings.views) {
    for (const diagnostic of view.status === 'ok' ? view.diagnostics : []) {
      const owner =
        diagnostic.origin !== undefined
          ? characterTarget(diagnostic.origin.characterId)
          : fromHome.has(identity(diagnostic))
            ? home
            : targetOfKey(key);
      const once = `${targetKey(owner)} ${identity(diagnostic)}`;

      if (said.has(once)) {
        continue;
      }

      said.add(once);

      const at = placeOf(diagnostic, owner);

      if (at?.kind === 'row') {
        add(rows, at.key, diagnostic.message);
      } else if (at?.kind === 'section') {
        add(sections, at.key, diagnostic.message);
      } else {
        notes.push(
          owner.scope === 'character'
            ? `${nameOf(owner.characterId)}: ${diagnostic.message}`
            : diagnostic.message,
        );
      }
    }
  }

  return {rows, sections, notes};
}

function identity(diagnostic: RuntimeConfigDiagnostic): string {
  return JSON.stringify(diagnostic);
}

/** Where an error is said: at the field it names, or on its section's page; a warning is a note. */
function placeOf(
  diagnostic: RuntimeConfigDiagnostic,
  target: ConfigTarget,
): {readonly kind: 'row' | 'section'; readonly key: string} | undefined {
  if (diagnostic.severity !== 'error') {
    return undefined;
  }

  if (diagnostic.scope === 'section') {
    const {namespace, id, field} = diagnostic;

    return field === undefined
      ? {
          kind: 'section',
          key: `${targetKey(target)}/${sectionKey(namespace, id)}`,
        }
      : {
          kind: 'row',
          key: rowKey({
            target,
            place: {kind: 'field', namespace, id, name: field},
          }),
        };
  }

  const host = /^project02\.([^.]+)$/u.exec(diagnostic.path ?? '')?.[1];

  return host === undefined
    ? undefined
    : {kind: 'row', key: rowKey({target, place: {kind: 'host', name: host}})};
}

/**
 * Whether the welcome's second step may go on: the home's settings give a
 * character an AI model already, or a service is chosen and its key is
 * stored or typed.
 */
export function welcomeReady(settings: Settings): boolean {
  const view = viewOf(settings, home);
  const service = view?.project02.find(
    field => field.name === 'roleModelProvider',
  );
  const key = view?.project02.find(field => field.name === 'nvidiaApiKey');
  const typed = settings.edits.get(
    rowKey({target: home, place: {kind: 'host', name: 'nvidiaApiKey'}}),
  );

  if (view === undefined || service === undefined) {
    return false;
  }

  return (
    view.model.ready ||
    (valueNow(
      settings,
      {target: home, place: {kind: 'host', name: 'roleModelProvider'}},
      service,
    ) !== undefined &&
      (key?.authored.configured === true || (typed ?? '').trim() !== ''))
  );
}

/** An entry of the sidebar: the page it opens, its name, its value, and whether it has something to finish. */
export type Entry = {
  readonly page: SettingsPage;
  readonly label: string;
  readonly value: string;
  readonly dot: boolean;
};

export type ArtEntry = Entry & {readonly icon: IconName; readonly tint: Tint};

export type Sidebar = {
  /** The name in effect. */
  readonly you: string;
  readonly characters: readonly (Entry & {readonly id: string})[];
  readonly connections: readonly ArtEntry[];
  readonly advanced: Entry;
};

/**
 * The sidebar: the person by their name; each character, off when she is
 * switched off; AI Model by the service it thinks with, or Set Up;
 * Telegram on or off; each plugin set up once for everyone by its first
 * choice, or on, or Set Up while a character has it switched on before it
 * is set up; and a dot wherever a section has an error, on its entry, on
 * her row for a section of hers, or on Advanced for a plugin with no entry
 * of its own.
 */
export function sidebarOf(
  settings: Settings,
  characters: readonly CharacterSummary[],
  found: Findings,
  advanced: boolean,
): Sidebar {
  const view = viewOf(settings, home);
  const wrong = (target: ConfigTarget, key?: string): boolean =>
    [...found.sections.keys()].some(said =>
      key === undefined
        ? said.startsWith(`${targetKey(target)}/`)
        : said === `${targetKey(target)}/${key}`,
    );
  const connected = connections(view);

  return {
    you: nameInEffect(settings),
    characters: characters.map(character => ({
      id: character.id,
      page: {kind: 'character', characterId: character.id},
      label: character.displayName,
      value: character.enabled ? '' : 'Off',
      dot: wrong(characterTarget(character.id)),
    })),
    connections: [
      {
        page: {kind: 'model'},
        label: 'AI Model',
        icon: 'sparkle',
        tint: 'indigo',
        ...modelEntry(view),
      },
      {
        page: {kind: 'telegram'},
        label: 'Telegram',
        icon: 'plane',
        tint: 'blue',
        value: view === undefined ? '' : telegramOn(settings) ? 'On' : 'Off',
        dot: wrong(home, sectionKey('connectors', 'telegram')),
      },
      ...connected.map(section => {
        const entry = connectionEntry(settings, section);

        return {
          page: {kind: 'connection', pluginId: section.id} as const,
          label: section.page?.connection ?? section.displayName,
          icon: iconOf(section.page?.icon),
          tint: tintOf(section.page?.tint),
          value: entry.value,
          dot: entry.dot || wrong(home, sectionKey('plugins', section.id)),
        };
      }),
    ],
    advanced: {
      page: {kind: 'advanced'},
      label: 'Advanced',
      value: advanced ? 'On' : '',
      dot: (view?.sections ?? []).some(
        section =>
          section.namespace === 'plugins' &&
          !isConnection(section) &&
          wrong(home, sectionKey('plugins', section.id)),
      ),
    },
  };
}

/** The person's name as the home's view has it in effect, or You. */
export function nameInEffect(settings: Settings): string {
  const name = viewOf(settings, home)?.project02.find(
    field => field.name === 'userDisplayName',
  )?.effective.value;

  return typeof name === 'string' ? name : 'You';
}

function modelEntry(view: OkView | undefined): {
  readonly value: string;
  readonly dot: boolean;
} {
  if (view === undefined) {
    return {value: '', dot: false};
  }

  const provider = view.project02.find(
    field => field.name === 'roleModelProvider',
  );
  const chosen = provider?.effective.value;

  return view.model.ready &&
    provider !== undefined &&
    typeof chosen === 'string'
    ? {value: choiceWords(provider, chosen), dot: false}
    : {value: 'Set Up', dot: true};
}

/** A plugin's entry: its first choice, or on, once set up; Set Up while a character has it on before that; off otherwise. */
function connectionEntry(
  settings: Settings,
  section: Section,
): {readonly value: string; readonly dot: boolean} {
  if (section.setup.ready) {
    return {
      value: featureValue(section, true, name => {
        const field = section.fields.find(candidate => candidate.name === name);

        return field === undefined
          ? undefined
          : valueNow(
              settings,
              {
                target: home,
                place: {
                  kind: 'field',
                  namespace: 'plugins',
                  id: section.id,
                  name,
                },
              },
              field,
            );
      }),
      dot: false,
    };
  }

  const wanted = [...settings.views.entries()].some(
    ([key, view]) =>
      key !== targetKey(home) &&
      view.status === 'ok' &&
      sectionOf(view, 'plugins', section.id)?.enabled === true,
  );

  return wanted ? {value: 'Set Up', dot: true} : {value: 'Off', dot: false};
}

/** A section's tile: its own, Telegram's, or the plainest. */
export function artOf(section: Section): {
  readonly icon: IconName;
  readonly tint: Tint;
} {
  if (section.page !== undefined) {
    return {icon: iconOf(section.page.icon), tint: tintOf(section.page.tint)};
  }

  return section.namespace === 'connectors' && section.id === 'telegram'
    ? {icon: 'plane', tint: 'blue'}
    : {icon: 'grid', tint: 'gray'};
}

/** The page a sub-page opens from, which its Back button returns to; none for a page of the sidebar. */
export function parentOf(page: SettingsPage): SettingsPage | undefined {
  switch (page.kind) {
    case 'feature':
    case 'character-model':
    case 'remove':
    case 'app':
    case 'get-apps':
      return {kind: 'character', characterId: page.characterId};
    case 'app-file':
      return {kind: 'get-apps', characterId: page.characterId};
    case 'bot':
      return page.from === 'telegram' || page.target.scope === 'global'
        ? {kind: 'telegram'}
        : {kind: 'character', characterId: page.target.characterId};
    case 'plugin':
      return {kind: 'advanced'};
    default:
      return undefined;
  }
}

/** Whether the sidebar's entry for `entry` is the one the page is on or opens from, however deep under it. */
export function marks(page: SettingsPage, entry: SettingsPage): boolean {
  let top = page;

  for (let up = parentOf(top); up !== undefined; up = parentOf(top)) {
    top = up;
  }

  return (
    top.kind === entry.kind && JSON.stringify(top) === JSON.stringify(entry)
  );
}

/** Who a character file holds and what adding her would do. */
export type CharacterPreview = Extract<CharacterPreviewOutcome, {status: 'ok'}>;

/** What a preview offers: its button, a line about her stay here, and the way to her page. */
export type Offer = {
  /** Adds her, or updates her; none when the file cannot. */
  readonly button?: string;
  readonly line?: string;
  /** Opens her page, when this very version of her is here. */
  readonly link?: string;
};

/**
 * What adding the character a file holds would do, by where she stands
 * here: add her when she is new, saying so when her chats from an earlier
 * stay are still here; update her when another version of her is here;
 * and nothing when this very version is, which leads to her page, or when
 * she comes with the app.
 */
export function offerOf(preview: CharacterPreview): Offer {
  const name = preview.displayName;

  switch (preview.installed) {
    case 'none':
      return {
        button: `Add ${name}`,
        ...(preview.hasData
          ? {line: 'Her chats and memories from before are still here.'}
          : {}),
      };
    case 'other_version':
      return {
        button: `Update ${name}`,
        line: `${name} is here in another version.`,
      };
    case 'same':
      return {line: `${name} is already here.`, link: `Open ${name}`};
    case 'built_in':
      return {line: `${name} comes with the app.`};
  }
}

/** A feature a character comes with, drawn as a chip: its name on its plugin's tile. */
export type Chip = {
  readonly id: string;
  readonly name: string;
  readonly icon: IconName;
  readonly tint: Tint;
};

/**
 * What she comes with: a chip for each feature this app has, by its name
 * on its plugin's tile, in the order her page shows them; and one plain
 * line for those she asks for that this app does not have, which no chip
 * stands for. A plugin her page has no row for has no chip: nothing of it
 * is changed there.
 */
export function comesWithOf(
  settings: Settings,
  features: readonly CharacterFeature[],
): {readonly chips: readonly Chip[]; readonly lacking?: string} {
  const listed = sectionsListed(settings).filter(
    section => section.namespace === 'plugins',
  );
  const placeOf = (id: string): number => {
    const at = listed.findIndex(section => section.id === id);

    return at === -1 ? listed.length : at;
  };
  const chips = features
    .flatMap(feature => (feature.kind === 'plugin' ? [feature] : []))
    .toSorted((left, right) => placeOf(left.id) - placeOf(right.id))
    .flatMap(feature => {
      const section = listed[placeOf(feature.id)];

      if (section !== undefined && section.page === undefined) {
        return [];
      }

      const art: {readonly icon: IconName; readonly tint: Tint} =
        section === undefined ? {icon: 'grid', tint: 'gray'} : artOf(section);

      return [{id: feature.id, name: feature.displayName, ...art}];
    });
  const unknown = features.flatMap(feature =>
    feature.kind === 'unknown' ? [feature.id] : [],
  );

  return {
    chips,
    ...(unknown.length === 0
      ? {}
      : {lacking: `This app does not have: ${unknown.join(', ')}.`}),
  };
}

/**
 * What a character added now would find set up: the AI model she thinks
 * with, ready or to be set up first, and each account set up once for
 * everyone, ready or optional.
 */
export function readinessOf(
  settings: Settings,
): readonly {readonly label: string; readonly value: string}[] {
  const view = viewOf(settings, home);

  if (view === undefined) {
    return [];
  }

  return [
    {label: 'AI Model', value: view.model.ready ? 'Ready' : 'Set Up First'},
    ...connections(view).map(section => ({
      label: section.displayName,
      value: section.setup.ready ? 'Ready' : 'Optional',
    })),
  ];
}
