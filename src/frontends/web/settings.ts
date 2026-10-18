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
  GatewayHealth,
  RuntimeConfigDiagnostic,
  RuntimeConfigFieldInspectShape,
  RuntimeConfigSectionInspectShape,
  RuntimeConfigSectionNamespace,
  RuntimeConfigValue,
} from '../../gateway/api/index.ts';
import {noticed, type SettingsPage, type WebState} from './store.ts';

type OkView = Extract<ConfigView, {status: 'ok'}>;

/** One row the screen can change, found by its key. */
export type SettingsRow =
  | {
      readonly kind: 'host';
      readonly field: RuntimeConfigFieldInspectShape;
    }
  | {
      readonly kind: 'section_field';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
      readonly field: RuntimeConfigFieldInspectShape;
    }
  | {
      readonly kind: 'section_enabled';
      readonly namespace: RuntimeConfigSectionNamespace;
      readonly id: string;
    };

/**
 * Keys: `project02.<field>` for a host field — its path on the wire —
 * `<namespace>/<id>` for a section's switch and `<namespace>/<id>/<field>`
 * for its field. A slash appears in no namespace, id or field name, so two
 * rows never share a key whatever their names.
 */
export function hostFieldKey(name: string): string {
  return `project02.${name}`;
}

export function sectionKey(
  namespace: RuntimeConfigSectionNamespace,
  id: string,
): string {
  return `${namespace}/${id}`;
}

export function sectionFieldKey(
  namespace: RuntimeConfigSectionNamespace,
  id: string,
  name: string,
): string {
  return `${sectionKey(namespace, id)}/${name}`;
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
 * beside it: a re-read after a save, a conflict or another surface's
 * change must not take a person's words. A view for another target is a
 * read that was let go.
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
      row !== undefined && row.kind !== 'section_enabled' && row.field.secret;
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
 * meanwhile stays to be saved; the view is left as it was read, its
 * fingerprint with it: the session lands the answer with a view read
 * after it, and only a read says what the daemon holds.
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
    case 'section_field':
      return text === undefined
        ? {
            kind: 'section_field_unset',
            namespace: row.namespace,
            id: row.id,
            field: row.field.name,
          }
        : {
            kind: 'section_field_set',
            namespace: row.namespace,
            id: row.id,
            field: row.field.name,
            value: valueOf(row.field, text),
          };
    case 'section_enabled':
      return {
        kind: 'section_enabled',
        namespace: row.namespace,
        id: row.id,
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

  for (const {namespace, id, fields} of view.sections) {
    if (sectionKey(namespace, id) === key) {
      return {kind: 'section_enabled', namespace, id};
    }

    const field = fields.find(
      candidate => sectionFieldKey(namespace, id, candidate.name) === key,
    );

    if (field !== undefined) {
      return {kind: 'section_field', namespace, id, field};
    }
  }

  return undefined;
}

/**
 * What the screen says at its top: every diagnostic no listed section's
 * block says, so one about the whole document, or about a section this
 * screen does not list, is still said.
 */
export function screenDiagnostics(
  view: OkView,
): readonly RuntimeConfigDiagnostic[] {
  return view.diagnostics.filter(
    diagnostic =>
      !view.sections.some(section => namesSection(diagnostic, section)),
  );
}

/**
 * What a section's block says: every diagnostic of the view that names
 * it. The section's own list holds only what resolving its values found;
 * the view's also holds what the character's activation and the plugin
 * catalog found of it.
 */
export function sectionDiagnostics(
  view: OkView,
  section: RuntimeConfigSectionInspectShape,
): readonly RuntimeConfigDiagnostic[] {
  return view.diagnostics.filter(diagnostic =>
    namesSection(diagnostic, section),
  );
}

function namesSection(
  diagnostic: RuntimeConfigDiagnostic,
  section: RuntimeConfigSectionInspectShape,
): boolean {
  return (
    diagnostic.scope === 'section' &&
    diagnostic.namespace === section.namespace &&
    diagnostic.id === section.id
  );
}

/**
 * Whether a connector's process is on the daemon's stream, as health says
 * it, and the command that starts one that is not: `pnpm <id>`. Nothing
 * for a connector health does not list.
 */
export function connectorPresenceSentence(
  health: GatewayHealth | undefined,
  id: string,
): string | undefined {
  const presence = health?.connectors.find(connector => connector.id === id);

  if (presence === undefined) {
    return undefined;
  }

  return presence.connected
    ? 'Connector: running.'
    : `Connector: not running. Start it with pnpm ${id}.`;
}

/**
 * A fresh home has chosen no provider: the home's view holds no value for
 * `roleModelProvider`. That is the whole judgement behind the first run's
 * frame.
 */
export function setupNeeded(view: ConfigView): boolean {
  return (
    view.status === 'ok' &&
    view.project02.some(
      field =>
        field.name === 'roleModelProvider' &&
        field.effective.source === 'missing',
    )
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
  field: RuntimeConfigFieldInspectShape,
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
function readsJson(field: RuntimeConfigFieldInspectShape): boolean {
  return (
    field.allowedValues === undefined &&
    (field.valueType === 'object' ||
      field.valueType === 'array' ||
      field.valueType === undefined)
  );
}

function valueOf(
  field: RuntimeConfigFieldInspectShape,
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
    (row.kind === 'section_enabled' || row.field.valueType === 'boolean')
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
