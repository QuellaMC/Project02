/**
 * The rules of a settings screen, as pure functions of the previous value
 * and one input, like the chat's: what the daemon's view says, what the
 * person typed, what the daemon answered a change with. The screen holds
 * no document, no defaults and no field list of its own — a field renders
 * by the shape the view gives it — and the one thing it adds is what is
 * typed and not yet saved. Nothing here touches the DOM.
 */
import type {
  ConfigChange,
  ConfigChangeOutcome,
  ConfigTarget,
  ConfigView,
  RuntimeConfigValue,
  RuntimePluginConfigFieldInspectShape,
} from '../../gateway/api/index.ts';
import {noticed, type SettingsPage, type WebState} from './store.ts';

/** One row the screen can change, found by its key. */
export type SettingsRow =
  | {
      readonly kind: 'host';
      readonly field: RuntimePluginConfigFieldInspectShape;
    }
  | {
      readonly kind: 'plugin_field';
      readonly pluginId: string;
      readonly field: RuntimePluginConfigFieldInspectShape;
    }
  | {readonly kind: 'plugin_enabled'; readonly pluginId: string};

/**
 * Keys: `project02.<field>` for a host field — its path on the wire —
 * `plugins/<id>` for a plugin's switch and `plugins/<id>/<field>` for its
 * field. A slash appears in no plugin id and no field name, so two rows
 * never share a key whatever their names.
 */
export function hostFieldKey(name: string): string {
  return `project02.${name}`;
}

export function pluginKey(pluginId: string): string {
  return `plugins/${pluginId}`;
}

export function pluginFieldKey(pluginId: string, name: string): string {
  return `${pluginKey(pluginId)}/${name}`;
}

export function sameTarget(left: ConfigTarget, right: ConfigTarget): boolean {
  return left.scope === 'global'
    ? right.scope === 'global'
    : right.scope === 'character' && left.characterId === right.characterId;
}

/**
 * The screen opens on a target; the thread stays in the store, hidden
 * behind it. Opening the screen already open is a refresh — the session
 * reads the view again — and takes nothing the person typed.
 */
export function settingsOpened(
  state: WebState,
  target: ConfigTarget,
  setup = false,
): WebState {
  return state.settings !== undefined &&
    sameTarget(state.settings.target, target)
    ? state
    : {
        ...state,
        settings: {target, setup, edits: new Map(), problems: new Map()},
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

/**
 * The view replaces, and what is typed and what the daemon refused stay
 * beside it: a re-read after a save or a conflict must not take a
 * person's words. A view for another target is a read that was let go.
 */
export function configViewRead(
  state: WebState,
  target: ConfigTarget,
  view: ConfigView,
): WebState {
  const {settings} = state;

  return settings === undefined || !sameTarget(settings.target, target)
    ? state
    : {...state, settings: {...settings, view}};
}

export function fieldEdited(
  state: WebState,
  key: string,
  text: string,
): WebState {
  return withSettings(state, settings => {
    const edits = new Map(settings.edits);

    edits.set(key, text);

    return {...withoutSaved(settings), edits};
  });
}

/**
 * The change is on its way from the screen that is open, under a ticket
 * of its own. A secret's text goes the moment it is sent: the daemon
 * redacts it from then on, and the tab keeps no copy either; any other
 * text is remembered as what was sent, so a newer word typed meanwhile
 * is told apart from it.
 */
export function changeSent(
  state: WebState,
  ticket: number,
  key: string,
): WebState {
  return withSettings(state, settings => {
    const row =
      settings.view?.status === 'ok' ? rowAt(settings.view, key) : undefined;
    const secret =
      row !== undefined && row.kind !== 'plugin_enabled' && row.field.secret;
    const edits = new Map(settings.edits);
    const problems = new Map(settings.problems);
    const text = edits.get(key);

    if (secret) {
      edits.delete(key);
    }

    problems.delete(key);

    return {
      ...withoutSaved(settings),
      edits,
      problems,
      saving: {ticket, key, ...(secret || text === undefined ? {} : {text})},
    };
  });
}

/**
 * How the change ended, known by its ticket: a screen opened since, or a
 * later change on it, is waiting on nothing this one can answer.
 * `applied`: the text that was sent is done with, and a newer word typed
 * meanwhile stays to be saved; the fingerprint the answer carries is the
 * view's from now on, so a save made before the session's re-read lands
 * cannot conflict with this one, and the re-read fills in the rest.
 * `refused` as `invalid`: the daemon's reason stays at the field, with
 * the text. `conflict`: someone else saved first; said once, and the
 * session re-reads, with the text still in the row. A character that is
 * gone closes the screen. A write the daemon could not make is said as
 * the daemon said it. A switch has no Save of its own, so a flip that
 * did not land is let go: the switch shows what the daemon has, and a
 * click sends it again.
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
  const {key} = saving;

  if (outcome.status === 'applied') {
    const edits = new Map(page.edits);
    const problems = new Map(page.problems);
    const newer =
      edits.has(key) && edits.get(key) !== saving.text
        ? edits.get(key)
        : undefined;

    edits.delete(key);
    problems.delete(key);

    if (newer !== undefined) {
      edits.set(key, newer);
    }

    return {
      ...state,
      settings: {
        ...page,
        ...(page.view?.status === 'ok'
          ? {view: {...page.view, fingerprint: outcome.fingerprint}}
          : {}),
        edits,
        problems,
        ...(newer === undefined ? {saved: key} : {}),
      },
    };
  }

  const kept = isSwitch(page, key) ? withoutEdit(page, key) : page;

  if (outcome.status === 'refused' && outcome.reason === 'invalid') {
    const problems = new Map(kept.problems);

    problems.set(key, outcome.message);

    return {...state, settings: {...kept, problems}};
  }

  const next: WebState = {...state, settings: kept};

  if (outcome.status === 'refused' && outcome.reason === 'unknown_character') {
    return noticed(settingsClosed(next), outcome.message);
  }

  return noticed(
    next,
    outcome.status === 'refused'
      ? 'Someone else saved first. This is what is there now; make your change again.'
      : outcome.message,
  );
}

/**
 * One operation from the row's shape, for the daemon to judge. Text is
 * typed by the field's valueType: a number when it reads as one, a
 * boolean from the switch, JSON for an object or array when it parses,
 * and the text itself otherwise — the daemon says what is wrong with it.
 * A secret goes as typed whatever kind it declares: the daemon takes a
 * credential as text only. No text is a reset: unset, or the plugin
 * switch cleared, so the row inherits again.
 */
export function operationFor(
  view: ConfigView,
  key: string,
  text: string | undefined,
): ConfigChange['operation'] | undefined {
  const row = rowAt(view, key);

  if (row === undefined) {
    return undefined;
  }

  switch (row.kind) {
    case 'host':
      return text === undefined
        ? {kind: 'unset', path: key}
        : {kind: 'set', path: key, value: valueOf(row.field, text)};
    case 'plugin_field':
      return text === undefined
        ? {
            kind: 'plugin_field_unset',
            pluginId: row.pluginId,
            field: row.field.name,
          }
        : {
            kind: 'plugin_field_set',
            pluginId: row.pluginId,
            field: row.field.name,
            value: valueOf(row.field, text),
          };
    case 'plugin_enabled':
      return {
        kind: 'plugin_enabled',
        pluginId: row.pluginId,
        ...(text === undefined ? {} : {enabled: text === 'true'}),
      };
  }
}

/** The row a key names, in the view as it stands. */
export function rowAt(view: ConfigView, key: string): SettingsRow | undefined {
  if (view.status !== 'ok') {
    return undefined;
  }

  const host = view.project02.find(field => hostFieldKey(field.name) === key);

  if (host !== undefined) {
    return {kind: 'host', field: host};
  }

  for (const plugin of view.plugins) {
    if (pluginKey(plugin.pluginId) === key) {
      return {kind: 'plugin_enabled', pluginId: plugin.pluginId};
    }

    const field = plugin.fields.find(
      candidate => pluginFieldKey(plugin.pluginId, candidate.name) === key,
    );

    if (field !== undefined) {
      return {kind: 'plugin_field', pluginId: plugin.pluginId, field};
    }
  }

  return undefined;
}

/**
 * A fresh home has chosen no provider: the home's view says so of
 * `roleModelProvider`, unauthored and with nothing in effect. That is the
 * whole judgement behind the first run's frame.
 */
export function setupNeeded(view: ConfigView): boolean {
  if (view.status !== 'ok') {
    return false;
  }

  const provider = view.project02.find(
    field => field.name === 'roleModelProvider',
  );

  return (
    provider !== undefined &&
    !provider.authored.configured &&
    provider.effective.source === 'missing'
  );
}

/** `userDisplayName` → `User display name`: the wire carries a name and a description, not a label. */
export function readableName(name: string): string {
  const words = name
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/[_-]+/gu, ' ')
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A value as its box shows it, so that what is shown saves back as what
 * it was: a field of no declared kind reads and writes JSON, quotes and
 * all, and every declared kind shows its text.
 */
export function valueText(
  field: RuntimePluginConfigFieldInspectShape,
  value: RuntimeConfigValue | undefined,
): string {
  if (value === undefined) {
    return '';
  }

  return typeof value === 'string' && !readsJson(field)
    ? value
    : JSON.stringify(value);
}

/** A structure, or a field of no declared kind, is typed as JSON; a choice among allowed values is never. */
function readsJson(field: RuntimePluginConfigFieldInspectShape): boolean {
  return (
    field.allowedValues === undefined &&
    (field.valueType === 'object' ||
      field.valueType === 'array' ||
      field.valueType === undefined)
  );
}

function valueOf(
  field: RuntimePluginConfigFieldInspectShape,
  text: string,
): RuntimeConfigValue {
  if (field.secret) {
    return text;
  }

  if (field.valueType === 'boolean') {
    return text === 'true';
  }

  if (field.valueType === 'number') {
    const number = Number(text);

    return text.trim().length > 0 && Number.isFinite(number) ? number : text;
  }

  // Everything else is the text as typed: the daemon judges it, and a
  // path is sent exactly as written.
  return readsJson(field) ? parsedOrText(text) : text;
}

function parsedOrText(text: string): RuntimeConfigValue {
  try {
    return JSON.parse(text) as RuntimeConfigValue;
  } catch {
    return text;
  }
}

function withSettings(
  state: WebState,
  update: (settings: SettingsPage) => SettingsPage,
): WebState {
  return state.settings === undefined
    ? state
    : {...state, settings: update(state.settings)};
}

/** A boolean field, or a plugin's switch: a row with no Save of its own. */
function isSwitch(page: SettingsPage, key: string): boolean {
  const row = page.view?.status === 'ok' ? rowAt(page.view, key) : undefined;

  return (
    row !== undefined &&
    (row.kind === 'plugin_enabled' || row.field.valueType === 'boolean')
  );
}

function withoutEdit(page: SettingsPage, key: string): SettingsPage {
  if (!page.edits.has(key)) {
    return page;
  }

  const edits = new Map(page.edits);

  edits.delete(key);

  return {...page, edits};
}

function withoutSaved(settings: SettingsPage): SettingsPage {
  if (settings.saved === undefined) {
    return settings;
  }

  const {saved, ...rest} = settings;

  void saved;

  return rest;
}
