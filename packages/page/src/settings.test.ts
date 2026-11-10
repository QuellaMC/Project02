import {describe, expect, it} from 'vitest';

import {
  advancedSet,
  changeEnded,
  changeSent,
  changedElsewhere,
  characterTarget,
  clickedText,
  conflictMet,
  editLetGo,
  editToSend,
  fieldEdited,
  home,
  operationFor,
  rowKey,
  settingsClosed,
  settingsOpened,
  targetKey,
  targetOfKey,
  viewsRead,
  welcomeOpened,
  welcomeStepped,
  type Row,
} from './settings.ts';
import {
  initialState,
  installSnapshot,
  threadOpened,
  type WebState,
} from './store.ts';
import type {
  ConfigView,
  GatewayHealth,
  JsonValue,
  RuntimeConfigFieldInspectShape,
  RuntimeConfigSectionInspectShape,
} from '@project02/wire/contract';

type OkView = Extract<ConfigView, {status: 'ok'}>;

/** A field with nothing of its own set, its value in effect `value` when one is given. */
function field(
  name: string,
  shape: Partial<RuntimeConfigFieldInspectShape> = {},
  value?: JsonValue,
): RuntimeConfigFieldInspectShape {
  return {
    name,
    description: `${name}.`,
    secret: false,
    valueType: 'string',
    agentMutable: false,
    authored: {configured: false},
    effectiveSource: 'default',
    effective: {
      name,
      secret: false,
      source: value === undefined ? 'missing' : 'default',
      resolved: true,
      ...(value === undefined ? {} : {value}),
    },
    ...shape,
  };
}

/** A field the target's own document sets to `value`. */
function own(
  name: string,
  value: JsonValue,
  shape: Partial<RuntimeConfigFieldInspectShape> = {},
): RuntimeConfigFieldInspectShape {
  return field(name, {
    ...shape,
    authored: {configured: true, value},
    effectiveSource: 'global',
    effective: {name, secret: false, source: 'config', resolved: true, value},
  });
}

const replyStyle: RuntimeConfigSectionInspectShape = {
  namespace: 'plugins',
  id: 'reply-style',
  displayName: 'Reply Style',
  version: '1.0.0',
  enabled: false,
  enabledSource: 'default',
  activation: {enabled: false, status: 'disabled', reasons: []},
  setup: {ready: true},
  fields: [
    field('tone', {allowedValues: ['neutral', 'warm']}),
    own('signoff', 'M.'),
  ],
  layout: [{advanced: false, rows: [{field: 'tone'}, {field: 'signoff'}]}],
  diagnostics: [],
};

function view(shape: Partial<OkView> = {}, fingerprint = 'f1'): OkView {
  return {
    status: 'ok',
    fingerprint,
    diagnostics: [],
    model: {ready: true},
    project02: [
      own('userDisplayName', 'Sam'),
      field('nvidiaApiKey', {secret: true}),
      field('contextWindowTokens', {valueType: 'number'}, 32768),
    ],
    sections: [replyStyle],
    ...shape,
  };
}

const health: GatewayHealth = {
  protocolVersion: 9,
  homeRoot: '/home/person/.project02',
  config: {diagnostics: []},
  packages: {diagnostics: []},
  characters: [
    {
      id: 'mira',
      displayName: 'Mira',
      enabled: true,
      builtIn: true,
      state: 'ready',
    },
  ],
  connectors: [],
};

const mira = characterTarget('mira');
const name: Row = {
  target: home,
  place: {kind: 'host', name: 'userDisplayName'},
};
const key: Row = {target: home, place: {kind: 'host', name: 'nvidiaApiKey'}};
const context: Row = {
  target: home,
  place: {kind: 'host', name: 'contextWindowTokens'},
};
const tone: Row = {
  target: mira,
  place: {kind: 'field', namespace: 'plugins', id: 'reply-style', name: 'tone'},
};
const replySwitch: Row = {
  target: mira,
  place: {kind: 'switch', namespace: 'plugins', id: 'reply-style'},
};

/** A live tab with Mira's thread open and the window in front of it, both views read. */
function opened(views: ReadonlyMap<string, ConfigView> = both()): WebState {
  const live = installSnapshot(initialState, {
    protocolVersion: 9,
    health,
    confirmations: [],
    pairings: [],
    turns: [],
  });

  return viewsRead(
    settingsOpened(
      threadOpened(live, {
        status: 'opened',
        conversationId: 'conv-1',
        characterId: 'mira',
      }),
      {kind: 'character', characterId: 'mira'},
    ),
    views,
  );
}

function both(home = view(), hers = view()): ReadonlyMap<string, ConfigView> {
  return new Map([
    ['home', home],
    ['character:mira', hers],
  ]);
}

describe('settings window', () => {
  it('opens on a page with the thread behind it, goes from page to page keeping the views and what is typed, and closes letting them go', () => {
    const typed = fieldEdited(opened(), name, 'Kim');
    const moved = settingsOpened(typed, {kind: 'telegram'});

    expect(moved.thread?.conversationId).toBe('conv-1');
    expect(moved.settings?.screen).toEqual({
      kind: 'window',
      page: {kind: 'telegram'},
    });
    expect(moved.settings?.views).toBe(typed.settings?.views);
    expect(moved.settings?.edits.get(rowKey(name))).toBe('Kim');

    const closed = settingsClosed(moved);

    expect(closed.settings).toBeUndefined();
    expect(closed.thread?.conversationId).toBe('conv-1');
    expect(settingsClosed(closed)).toBe(closed);
  });

  it('opens the welcome on its first step while the home gives a character no AI model, over nothing the person opened, and steps through it', () => {
    const fresh = view({
      model: {ready: false, message: 'Choose an AI service.'},
    });
    const welcomed = welcomeOpened(initialState, fresh);

    expect(welcomed.settings?.screen).toEqual({kind: 'welcome', step: 1});
    expect(welcomed.settings?.views.get('home')).toBe(fresh);
    expect(welcomeStepped(welcomed, 2).settings?.screen).toEqual({
      kind: 'welcome',
      step: 2,
    });
    expect(welcomeOpened(initialState, view())).toBe(initialState);
    expect(welcomeOpened(opened(), fresh).settings?.screen.kind).toBe('window');
    expect(welcomeStepped(opened(), 2)).toEqual(opened());
  });

  it('keeps the views in step: a read replaces them whole and keeps what is typed and what was said', () => {
    const said = changeEnded(
      changeSent(fieldEdited(opened(), name, ''), 1, name),
      1,
      {status: 'refused', reason: 'invalid', message: 'A name is needed.'},
    );
    const fresh = both(view({}, 'f2'));
    const reread = viewsRead(said, fresh);

    expect(reread.settings?.views).toBe(fresh);
    expect(reread.settings?.edits.get(rowKey(name))).toBe('');
    expect(reread.settings?.problems.get(rowKey(name))).toBe(
      'A name is needed.',
    );
    expect(viewsRead(initialState, fresh)).toBe(initialState);
  });

  it('sends a box when it changed: nothing for what it held, an unset when emptied, the value typed by the field; a key whenever one is typed', () => {
    const sends = (row: Row, text: string) => {
      const settings = fieldEdited(opened(), row, text).settings;

      return settings === undefined ? 'closed' : editToSend(settings, row);
    };

    expect(sends(name, 'Sam')).toBeUndefined();
    expect(sends(name, '  ')).toEqual({});
    expect(sends(name, 'Kim')).toEqual({value: 'Kim'});
    expect(sends(context, '4096')).toEqual({value: 4096});
    expect(sends(context, 'lots')).toEqual({value: 'lots'});
    expect(sends(context, '')).toBeUndefined();
    expect(sends(key, ' nvapi-1 ')).toEqual({value: 'nvapi-1'});
    expect(sends(key, ' ')).toBeUndefined();

    const untouched = opened().settings;

    expect(
      untouched === undefined ? 'closed' : editToSend(untouched, name),
    ).toBeUndefined();
    expect(
      editLetGo(fieldEdited(opened(), name, 'Sam'), name).settings?.edits.size,
    ).toBe(0);
  });

  it('lets a key go the moment it is sent, and keeps what a box sent to tell a newer word apart', () => {
    const sent = changeSent(fieldEdited(opened(), key, 'nvapi-1'), 1, key);

    expect(sent.settings?.edits.has(rowKey(key))).toBe(false);
    expect(sent.settings?.saving).not.toHaveProperty('text');
    expect(JSON.stringify([...(sent.settings?.edits ?? [])])).not.toContain(
      'nvapi-1',
    );

    const typed = changeSent(fieldEdited(opened(), name, 'Kim'), 2, name);

    expect(typed.settings?.saving).toMatchObject({
      ticket: 2,
      ...name,
      text: 'Kim',
      retried: false,
    });
  });

  it('ends a change by its ticket: applied shows the check and keeps a newer word; a refusal and a failed write are said at the row, a box keeping its text and a click showing what the daemon has; a gone character is a notice', () => {
    const sent = changeSent(fieldEdited(opened(), name, 'Kim'), 1, name);
    const applied = changeEnded(sent, 1, {
      status: 'applied',
      fingerprint: 'f2',
    });

    expect(applied.settings?.saved).toEqual({key: rowKey(name), ticket: 1});
    expect(applied.settings?.edits.has(rowKey(name))).toBe(false);
    expect(applied.settings?.saving).toBeUndefined();
    expect(fieldEdited(applied, name, 'Jo').settings?.saved).toBeUndefined();
    expect(changeEnded(sent, 2, {status: 'applied', fingerprint: 'f2'})).toBe(
      sent,
    );

    const newer = changeEnded(fieldEdited(sent, name, 'Kimi'), 1, {
      status: 'applied',
      fingerprint: 'f2',
    });

    expect(newer.settings?.edits.get(rowKey(name))).toBe('Kimi');
    expect(newer.settings?.saved).toBeUndefined();

    const invalid = changeEnded(sent, 1, {
      status: 'refused',
      reason: 'invalid',
      message: 'Too long.',
    });

    expect(invalid.settings?.problems.get(rowKey(name))).toBe('Too long.');
    expect(invalid.settings?.edits.get(rowKey(name))).toBe('Kim');

    // What was said at a row goes with the next change there.
    expect(
      changeEnded(changeSent(invalid, 2, name), 2, {
        status: 'applied',
        fingerprint: 'f3',
      }).settings?.problems.size,
    ).toBe(0);

    const clicked = changeEnded(
      changeSent(fieldEdited(opened(), tone, 'warm'), 1, tone),
      1,
      {status: 'failed', message: 'The disk is full.'},
    );

    expect(clicked.settings?.problems.get(rowKey(tone))).toBe(
      'The disk is full.',
    );
    expect(clicked.settings?.edits.has(rowKey(tone))).toBe(false);

    const gone = changeEnded(sent, 1, {
      status: 'refused',
      reason: 'unknown_character',
      message: 'Character "mira" was not found.',
    });

    expect(gone.notices).toEqual(['Character "mira" was not found.']);
    expect(gone.settings?.edits.has(rowKey(name))).toBe(false);
  });

  it('sends a change again once when someone else saved first and its row holds what it held, and otherwise shows what it holds now and says so', () => {
    const sent = changeSent(fieldEdited(opened(), tone, 'warm'), 1, tone);
    const elsewhere = view({}, 'f2');
    const again = conflictMet(sent, 1, elsewhere);

    expect(again.again).toBe(true);
    expect(again.state.settings?.saving?.retried).toBe(true);

    // Sent once more and met again: never a loop.
    const twice = conflictMet(again.state, 1, elsewhere);

    expect(twice.again).toBe(false);
    expect(twice.state.settings?.saving).toBeUndefined();
    expect(twice.state.settings?.problems.get(rowKey(tone))).toBe(
      changedElsewhere,
    );
    expect(twice.state.settings?.edits.has(rowKey(tone))).toBe(false);

    // The row itself moved: it shows what it holds now.
    const moved = conflictMet(
      sent,
      1,
      view({
        sections: [
          {
            ...replyStyle,
            fields: [
              own('tone', 'neutral', {allowedValues: ['neutral', 'warm']}),
            ],
          },
        ],
      }),
    );

    expect(moved.again).toBe(false);
    expect(moved.state.settings?.problems.get(rowKey(tone))).toBe(
      changedElsewhere,
    );
    expect(conflictMet(sent, 2, elsewhere)).toEqual({
      state: sent,
      again: false,
    });
    expect(conflictMet(sent, 1, undefined).again).toBe(false);

    // A switch holds its state and where that is decided.
    const flipped = changeSent(
      fieldEdited(opened(), replySwitch, 'true'),
      3,
      replySwitch,
    );

    expect(conflictMet(flipped, 3, view({}, 'f3')).again).toBe(true);
    expect(
      conflictMet(
        flipped,
        3,
        view({
          sections: [{...replyStyle, enabled: true, enabledSource: 'global'}],
        }),
      ).again,
    ).toBe(false);
  });

  it('builds one operation for each kind of row: set or unset a host field or a section field, and a switch on, off or left to the document beneath', () => {
    expect(operationFor(name.place, 'Kim')).toEqual({
      kind: 'set',
      path: 'project02.userDisplayName',
      value: 'Kim',
    });
    expect(operationFor(name.place, undefined)).toEqual({
      kind: 'unset',
      path: 'project02.userDisplayName',
    });
    expect(operationFor(tone.place, 'warm')).toEqual({
      kind: 'section_field_set',
      namespace: 'plugins',
      id: 'reply-style',
      field: 'tone',
      value: 'warm',
    });
    expect(operationFor(tone.place, undefined)).toEqual({
      kind: 'section_field_unset',
      namespace: 'plugins',
      id: 'reply-style',
      field: 'tone',
    });
    expect(operationFor(replySwitch.place, false)).toEqual({
      kind: 'section_enabled',
      namespace: 'plugins',
      id: 'reply-style',
      enabled: false,
    });
    expect(operationFor(replySwitch.place, undefined)).toEqual({
      kind: 'section_enabled',
      namespace: 'plugins',
      id: 'reply-style',
    });
  });

  it('keys every row by its target and place, so no two rows share one', () => {
    const keys = [name, key, tone, replySwitch, {...tone, target: home}].map(
      rowKey,
    );

    expect(new Set(keys).size).toBe(keys.length);
    expect(targetOfKey(targetKey(mira))).toEqual(mira);
    expect(targetOfKey(targetKey(home))).toEqual(home);
    expect(clickedText(true)).toBe('true');
    expect(clickedText('warm')).toBe('warm');
    expect(clickedText(undefined)).toBe('');
    expect(clickedText({'7': 'Kim'})).toBe('{"7":"Kim"}');
    expect(advancedSet(initialState, true).advanced).toBe(true);
    expect(advancedSet(initialState, false)).toBe(initialState);
  });
});
