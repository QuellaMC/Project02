/**
 * The rules of the settings in front of the chat, the window and the first
 * run's welcome, as pure functions of the previous value and one input,
 * like the chat's: the views the daemon handed out, what the person typed
 * or clicked, what the daemon answered a change with. The page holds no
 * document and no defaults of its own: every value it shows is a view's,
 * and the one thing it adds is what is typed and not yet saved. Nothing
 * here touches the DOM.
 */
import type {
  AddCharacterOutcome,
  CharacterPreviewOutcome,
  ConfigChange,
  ConfigChangeOutcome,
  ConfigTarget,
  ConfigView,
  JsonValue,
  RemoveCharacterOutcome,
  RuntimeConfigFieldInspectShape,
  RuntimeConfigSectionInspectShape,
  RuntimeConfigSectionNamespace,
} from '@project02/wire/contract';
import {
  characterLeft,
  noticed,
  type Settings,
  type SettingsPage,
  type SettingsPlace,
  type WebState,
} from './store.ts';

export type OkView = Extract<ConfigView, {status: 'ok'}>;
export type Field = RuntimeConfigFieldInspectShape;
export type Section = RuntimeConfigSectionInspectShape;

/** One value of one target: what a box, a switch or a choice changes. */
export type Row = {
  readonly target: ConfigTarget;
  readonly place: SettingsPlace;
};

export const home: ConfigTarget = {scope: 'global'};

export function characterTarget(characterId: string): ConfigTarget {
  return {scope: 'character', characterId};
}

const characterPrefix = 'character:';

/** A target's key among the views: `home`, or `character:<id>`. */
export function targetKey(target: ConfigTarget): string {
  return target.scope === 'global'
    ? 'home'
    : `${characterPrefix}${target.characterId}`;
}

export function targetOfKey(key: string): ConfigTarget {
  return key.startsWith(characterPrefix)
    ? characterTarget(key.slice(characterPrefix.length))
    : home;
}

/**
 * A row's key: its target's, then `project02.<field>` for a host field,
 * `<namespace>/<id>` for a section's switch and `<namespace>/<id>/<field>`
 * for a section's field. A slash is in no target, namespace, id or field
 * name, so two rows never share a key.
 */
export function rowKey({target, place}: Row): string {
  return `${targetKey(target)}/${placeKey(place)}`;
}

function placeKey(place: SettingsPlace): string {
  switch (place.kind) {
    case 'host':
      return `project02.${place.name}`;
    case 'switch':
      return sectionKey(place.namespace, place.id);
    case 'field':
      return `${sectionKey(place.namespace, place.id)}/${place.name}`;
  }
}

export function sectionKey(
  namespace: RuntimeConfigSectionNamespace,
  id: string,
): string {
  return `${namespace}/${id}`;
}

/** The target's view, once it was read and could be. */
export function viewOf(
  settings: Settings,
  target: ConfigTarget,
): OkView | undefined {
  const view = settings.views.get(targetKey(target));

  return view?.status === 'ok' ? view : undefined;
}

export function sectionOf(
  view: OkView,
  namespace: RuntimeConfigSectionNamespace,
  id: string,
): Section | undefined {
  return view.sections.find(
    section => section.namespace === namespace && section.id === id,
  );
}

/** The field a place names in a view; none for a section's switch. */
export function fieldAt(view: OkView, place: SettingsPlace): Field | undefined {
  switch (place.kind) {
    case 'host':
      return view.project02.find(field => field.name === place.name);
    case 'field':
      return sectionOf(view, place.namespace, place.id)?.fields.find(
        field => field.name === place.name,
      );
    case 'switch':
      return undefined;
  }
}

/**
 * The window opens on a page, or goes to it when it is open; the thread
 * stays behind it. The views and what is typed stay: going from page to
 * page loses nothing, and the session reads the views again on opening.
 */
export function settingsOpened(state: WebState, page: SettingsPage): WebState {
  const screen = {kind: 'window', page} as const;

  return {
    ...state,
    settings:
      state.settings === undefined
        ? settingsOn(screen, new Map())
        : {...state.settings, screen},
  };
}

/** The settings on a screen, with these views read and nothing else yet. */
function settingsOn(
  screen: Settings['screen'],
  views: Settings['views'],
): Settings {
  return {
    screen,
    views,
    edits: new Map(),
    problems: new Map(),
    phones: new Map(),
    catalogs: new Map(),
  };
}

/** Back to the chat; what was typed and not saved is let go. */
export function settingsClosed(state: WebState): WebState {
  if (state.settings === undefined) {
    return state;
  }

  const {settings, ...rest} = state;

  void settings;

  return rest;
}

/** Whether a view says its settings give a character no AI model: the first run's whole judgement. */
function welcomeNeeded(view: ConfigView): boolean {
  return view.status === 'ok' && !view.model.ready;
}

/**
 * The first run's welcome opens on its first step when the home's view
 * gives a character no AI model, over nothing the person opened.
 */
export function welcomeOpened(state: WebState, homeView: ConfigView): WebState {
  return state.settings !== undefined || !welcomeNeeded(homeView)
    ? state
    : {
        ...state,
        settings: settingsOn(
          {kind: 'welcome', step: 1},
          new Map([[targetKey(home), homeView]]),
        ),
      };
}

export function welcomeStepped(state: WebState, step: 1 | 2 | 3): WebState {
  return state.settings?.screen.kind === 'welcome'
    ? {...state, settings: {...state.settings, screen: {kind: 'welcome', step}}}
    : state;
}

export function advancedSet(state: WebState, advanced: boolean): WebState {
  return state.advanced === advanced ? state : {...state, advanced};
}

/** The page the window is on, while it is open. */
export function windowPage(state: WebState): SettingsPage | undefined {
  const screen = state.settings?.screen;

  return screen?.kind === 'window' ? screen.page : undefined;
}

/** What the file chooser offers for a character: her one file, a JSON document. */
export const characterFileTypes = '.json,application/json';

/** The largest character file: the daemon reads none larger. */
const characterFileBytes = 64 * 1024;

/**
 * Why the page does not send a chosen file, by its size: none larger than
 * a character file can be is ever sent.
 */
export function characterFileRefusal(size: number): string | undefined {
  return size > characterFileBytes
    ? 'This file is too large to be a character file.'
    : undefined;
}

/** Said of a chosen file that cannot be read as text. */
export const unreadableFile = "This file can't be read.";

/**
 * A file the person chose, and what was said of it: the window shows its
 * preview, keeping the file's text to send again only when it holds a
 * character. A file chosen from a preview goes back where the first was
 * chosen from.
 */
export function characterPreviewed(
  state: WebState,
  file: {readonly name: string; readonly text?: string},
  preview: CharacterPreviewOutcome,
): WebState {
  const page = windowPage(state);

  if (page === undefined) {
    return state;
  }

  return settingsOpened(state, {
    kind: 'add',
    fileName: file.name,
    ...(preview.status === 'ok' && file.text !== undefined
      ? {text: file.text}
      : {}),
    preview,
    from: page.kind === 'add' ? page.from : page,
  });
}

/** A call nothing answered, said as a write that failed is. */
type Unanswered = {readonly status: 'failed'; readonly message: string};

/**
 * How adding her ended, heard by the preview that asked, `asked`, while
 * its file is still the one shown: added or updated, the window opens her
 * page and the file goes with the preview; otherwise the preview stays
 * and says why, in the daemon's words. A preview the person has left, for
 * another file or another page, is not answered in its place: when she
 * was added the roster says so, and what kept her out is a notice.
 */
export function characterAddEnded(
  state: WebState,
  asked: Extract<SettingsPage, {kind: 'add'}>,
  outcome: AddCharacterOutcome | Unanswered,
): WebState {
  const page = windowPage(state);
  const shown =
    page?.kind === 'add' &&
    page.fileName === asked.fileName &&
    page.text === asked.text
      ? page
      : undefined;

  if (outcome.status === 'added' || outcome.status === 'updated') {
    return shown === undefined
      ? state
      : settingsOpened(state, {
          kind: 'character',
          characterId: outcome.characterId,
        });
  }

  return shown === undefined
    ? noticed(state, outcome.message)
    : settingsOpened(state, {...shown, problem: outcome.message});
}

/**
 * How removing her ended: removed, the window leaves every page of hers;
 * otherwise her confirmation stays and says why, in the daemon's words.
 */
export function characterRemoveEnded(
  state: WebState,
  characterId: string,
  outcome: RemoveCharacterOutcome | Unanswered,
): WebState {
  if (outcome.status === 'removed') {
    return characterLeft(state, characterId);
  }

  const page = windowPage(state);

  return page?.kind === 'remove' && page.characterId === characterId
    ? settingsOpened(state, {...page, problem: outcome.message})
    : state;
}

/**
 * Every view as one read found them: they replace the views whole, and
 * what is typed and what the daemon said of a change stay beside them, so
 * a re-read after a save, a conflict or another surface's change takes
 * none of a person's words.
 */
export function viewsRead(
  state: WebState,
  views: ReadonlyMap<string, ConfigView>,
): WebState {
  return withSettings(state, settings => ({...settings, views}));
}

export function fieldEdited(state: WebState, row: Row, text: string): WebState {
  return withSettings(state, settings => {
    const edits = new Map(settings.edits);

    edits.set(rowKey(row), text);

    return {...withoutSaved(settings), edits};
  });
}

/** A box left as it was: nothing is sent, and it shows the view's value again. */
export function editLetGo(state: WebState, row: Row): WebState {
  return withSettings(state, settings => withoutEdit(settings, rowKey(row)));
}

/** A click's value, as its row keeps it until the view says it landed. */
export function clickedText(value: JsonValue | undefined): string {
  return value === undefined ? '' : valueText(value);
}

/**
 * What leaving a box, or pressing Return in it, sends: nothing when it
 * holds no edit or the text it held; an unset when it was emptied, so the
 * value inherits again; and otherwise the text as the field's value. A key
 * box is always empty: a key typed into it is sent, and leaving it empty
 * sends nothing.
 */
export function editToSend(
  settings: Settings,
  row: Row,
): {readonly value?: JsonValue} | undefined {
  const text = settings.edits.get(rowKey(row));
  const view = viewOf(settings, row.target);
  const field = view === undefined ? undefined : fieldAt(view, row.place);

  if (text === undefined || field === undefined) {
    return undefined;
  }

  if (field.secret) {
    return text.trim() === '' ? undefined : {value: text.trim()};
  }

  const held = ownText(field);

  if (text === held || (text.trim() === '' && held === '')) {
    return undefined;
  }

  return text.trim() === '' ? {} : {value: valueFrom(field, text)};
}

/**
 * The change is on its way under a ticket of its own, with what its row
 * held in the view it was sent against. A secret's text goes the moment it
 * is sent: the daemon never sends it back, and the tab keeps no copy.
 */
export function changeSent(
  state: WebState,
  ticket: number,
  row: Row,
): WebState {
  return withSettings(state, settings => {
    const key = rowKey(row);
    const view = viewOf(settings, row.target);
    const secret =
      view !== undefined && fieldAt(view, row.place)?.secret === true;
    const text = settings.edits.get(key);
    const problems = new Map(settings.problems);

    problems.delete(key);

    return {
      ...withoutSaved(secret ? withoutEdit(settings, key) : settings),
      problems,
      saving: {
        ticket,
        target: row.target,
        place: row.place,
        ...(secret || text === undefined ? {} : {text}),
        base: view === undefined ? '' : rowValue(view, row.place),
        retried: false,
      },
    };
  });
}

/** What the row says when someone else changed it first and it shows that now. */
export const changedElsewhere =
  'This was changed somewhere else, so it shows what it is now.';

/**
 * How the change ended, known by its ticket: a later change is waiting on
 * nothing this one can answer. `applied`: the text sent is done with, a
 * newer word typed meanwhile stays to be saved, and the check shows; the
 * view stays as it was read, and the session lands the answer with a view
 * read after it. A refusal, or a write the daemon could not make, is said
 * at its row in the daemon's words with the person's text kept; a click
 * has no text to keep, so its row shows what the daemon has. Someone else
 * saving first is `conflictMet`'s to judge; what reaches here of it is
 * said at the row, which shows what it holds now. A character that is
 * gone is a notice.
 */
export function changeEnded(
  state: WebState,
  ticket: number,
  outcome: ConfigChangeOutcome,
): WebState {
  const {settings} = state;

  if (settings?.saving?.ticket !== ticket) {
    return state;
  }

  const {saving, ...page} = settings;
  const key = rowKey(saving);

  if (outcome.status === 'applied') {
    const typed = page.edits.get(key);
    const newer = typed !== undefined && typed !== saving.text;

    return {
      ...state,
      settings: newer
        ? page
        : {...withoutEdit(page, key), saved: {key, ticket}},
    };
  }

  if (outcome.status === 'refused' && outcome.reason === 'unknown_character') {
    return noticed(
      {...state, settings: withoutEdit(page, key)},
      outcome.message,
    );
  }

  const moved = outcome.status === 'refused' && outcome.reason === 'conflict';
  const problems = new Map(page.problems);

  problems.set(key, moved ? changedElsewhere : outcome.message);

  return {
    ...state,
    settings: {
      ...(moved || !typedInto(page, saving) ? withoutEdit(page, key) : page),
      problems,
    },
  };
}

/**
 * Someone else saved first, and a read found the target's view as it is
 * now. The same change is to be sent once more against it only while its
 * row holds what it held when the change was sent; otherwise, or once it
 * was sent again already, the row shows what it holds now and says so.
 * Never more than once: the caller lands the view, and `again` says
 * whether to send.
 */
export function conflictMet(
  state: WebState,
  ticket: number,
  view: ConfigView | undefined,
): {readonly state: WebState; readonly again: boolean} {
  const saving = state.settings?.saving;

  if (saving?.ticket !== ticket) {
    return {state, again: false};
  }

  if (
    !saving.retried &&
    view?.status === 'ok' &&
    rowValue(view, saving.place) === saving.base
  ) {
    return {
      state: withSettings(state, settings => ({
        ...settings,
        saving: {...saving, retried: true},
      })),
      again: true,
    };
  }

  return {
    state: changeEnded(state, ticket, {
      status: 'refused',
      reason: 'conflict',
      message: changedElsewhere,
    }),
    again: false,
  };
}

/** What a row holds in a view, comparable: its own value and the one in effect, or its switch and where that is decided. */
function rowValue(view: OkView, place: SettingsPlace): string {
  if (place.kind === 'switch') {
    const section = sectionOf(view, place.namespace, place.id);

    return JSON.stringify([section?.enabled, section?.enabledSource]);
  }

  const field = fieldAt(view, place);

  return JSON.stringify([field?.authored, field?.effective.value]);
}

/** The one operation a change of a row to `value` is; no value unsets it, or leaves a switch to the document beneath. */
export function operationFor(
  place: SettingsPlace,
  value: JsonValue | undefined,
): ConfigChange['operation'] {
  switch (place.kind) {
    case 'host': {
      const path = `project02.${place.name}`;

      return value === undefined
        ? {kind: 'unset', path}
        : {kind: 'set', path, value};
    }
    case 'switch':
      return {
        kind: 'section_enabled',
        namespace: place.namespace,
        id: place.id,
        ...(typeof value === 'boolean' ? {enabled: value} : {}),
      };
    case 'field': {
      const {namespace, id, name: field} = place;

      return value === undefined
        ? {kind: 'section_field_unset', namespace, id, field}
        : {kind: 'section_field_set', namespace, id, field, value};
    }
  }
}

/** A value as a box shows it: text as it is, anything else as JSON. */
export function valueText(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** What the target's own document holds for the field, as its box shows it. */
export function ownText(field: Field): string {
  return field.authored.configured && field.authored.value !== undefined
    ? valueText(field.authored.value)
    : '';
}

/**
 * The field's value from what is typed: a number when it reads as one,
 * and the text itself otherwise, for the daemon to judge.
 */
function valueFrom(field: Field, text: string): JsonValue {
  const number = Number(text);

  return field.valueType === 'number' && Number.isFinite(number)
    ? number
    : text;
}

/** Whether the row is a box the person types into, whose text a refusal keeps. */
function typedInto(settings: Settings, saving: Row): boolean {
  const view = viewOf(settings, saving.target);
  const field = view === undefined ? undefined : fieldAt(view, saving.place);

  return field !== undefined && boxed(field);
}

/** A field changed by typing into a box, not by a click. */
function boxed(field: Field): boolean {
  return (
    field.secret ||
    (field.valueType !== 'boolean' &&
      field.valueType !== 'object' &&
      field.valueType !== 'array' &&
      field.allowedValues === undefined)
  );
}

function withSettings(
  state: WebState,
  update: (settings: Settings) => Settings,
): WebState {
  return state.settings === undefined
    ? state
    : {...state, settings: update(state.settings)};
}

function withoutEdit(settings: Settings, key: string): Settings {
  if (!settings.edits.has(key)) {
    return settings;
  }

  const edits = new Map(settings.edits);

  edits.delete(key);

  return {...settings, edits};
}

function withoutSaved(settings: Settings): Settings {
  if (settings.saved === undefined) {
    return settings;
  }

  const {saved, ...rest} = settings;

  void saved;

  return rest;
}
