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

/** Keys: `project02.<field>` · `plugins.<id>` for the switch · `plugins.<id>.<field>`. */
export function hostFieldKey(name: string): string {
  return `project02.${name}`;
}

export function pluginKey(pluginId: string): string {
  return `plugins.${pluginId}`;
}

export function pluginFieldKey(pluginId: string, name: string): string {
  return `${pluginKey(pluginId)}.${name}`;
}

export function sameTarget(left: ConfigTarget, right: ConfigTarget): boolean {
  return left.scope === 'global'
    ? right.scope === 'global'
    : right.scope === 'character' && left.characterId === right.characterId;
}

/** The screen opens on a target; the thread stays in the store, hidden behind it. */
export function settingsOpened(
  state: WebState,
  target: ConfigTarget,
  setup = false,
): WebState {
  return {
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
 * The change is on its way. A secret's text goes the moment it is sent:
 * the daemon redacts it from then on, and the tab keeps no copy either.
 */
export function changeSent(state: WebState, key: string): WebState {
  return withSettings(state, settings => {
    const row =
      settings.view?.status === 'ok' ? rowAt(settings.view, key) : undefined;
    const edits = new Map(settings.edits);
    const problems = new Map(settings.problems);

    if (
      row !== undefined &&
      row.kind !== 'plugin_enabled' &&
      row.field.secret
    ) {
      edits.delete(key);
    }

    problems.delete(key);

    return {...withoutSaved(settings), edits, problems, saving: key};
  });
}

/**
 * How the change ended. `applied`: the edit is done with, and the session
 * re-reads the view. `refused` as `invalid`: the daemon's reason stays at
 * the field, with the text. `conflict`: someone else saved first; said
 * once, and the session re-reads, with the text still in the row. A
 * character that is gone closes the screen. A write the daemon could not
 * make is said as the daemon said it.
 */
export function changeEnded(
  state: WebState,
  key: string,
  outcome: ConfigChangeOutcome,
): WebState {
  const {settings} = state;

  if (settings === undefined) {
    return state;
  }

  const {saving, ...page} = settings;

  void saving;

  if (outcome.status === 'applied') {
    const edits = new Map(page.edits);
    const problems = new Map(page.problems);

    edits.delete(key);
    problems.delete(key);

    return {...state, settings: {...page, edits, problems, saved: key}};
  }

  if (outcome.status === 'refused' && outcome.reason === 'invalid') {
    const problems = new Map(page.problems);

    problems.set(key, outcome.message);

    return {...state, settings: {...page, problems}};
  }

  const next: WebState = {...state, settings: page};

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
 * No text is a reset: unset, or the plugin switch cleared, so the row
 * inherits again.
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

/** A value as a box shows it: JSON for a structure, the text of anything else. */
export function valueText(value: RuntimeConfigValue | undefined): string {
  if (value === undefined) {
    return '';
  }

  return typeof value === 'string' ? value : JSON.stringify(value);
}

function valueOf(
  field: RuntimePluginConfigFieldInspectShape,
  text: string,
): RuntimeConfigValue {
  const {valueType} = field;

  if (valueType === 'boolean') {
    return text === 'true';
  }

  if (valueType === 'number') {
    const number = Number(text);

    return text.trim().length > 0 && Number.isFinite(number) ? number : text;
  }

  if (
    valueType === 'object' ||
    valueType === 'array' ||
    valueType === undefined
  ) {
    return parsedOrText(text);
  }

  // Every other kind is text: a single-line box has no edge whitespace a
  // person means.
  return text.trim();
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

function withoutSaved(settings: SettingsPage): SettingsPage {
  if (settings.saved === undefined) {
    return settings;
  }

  const {saved, ...rest} = settings;

  void saved;

  return rest;
}
