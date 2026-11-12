import {describe, expect, it} from 'vitest';

import {
  advancedSet,
  changeEnded,
  changeSent,
  changedElsewhere,
  characterAddEnded,
  characterFileRefusal,
  characterPreviewed,
  characterRemoveEnded,
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
  applyEvent,
  initialState,
  installSnapshot,
  threadOpened,
  type SettingsPage,
  type WebState,
} from './store.ts';
import type {
  CharacterPreviewOutcome,
  CharacterSummary,
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
    services: [],
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
  protocolVersion: 14,
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
  accounts: [],
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
    protocolVersion: 14,
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

/** The page the window is on, while it is open. */
function pageOf(state: WebState): SettingsPage | undefined {
  return state.settings?.screen.kind === 'window'
    ? state.settings.screen.page
    : undefined;
}

const nova: CharacterSummary = {
  id: 'nova',
  displayName: 'Nova',
  enabled: true,
  builtIn: false,
  state: 'ready',
};

/** Nova as a file holds her, new here. */
const novaFile: CharacterPreviewOutcome = {
  status: 'ok',
  id: 'nova',
  displayName: 'Nova',
  version: '1.0.0',
  comesWith: [],
  installed: 'none',
  hasData: false,
};

/** A live tab whose roster is these characters, the window open on this page. */
function windowOn(
  page: SettingsPage,
  characters: readonly CharacterSummary[],
): WebState {
  return settingsOpened(
    installSnapshot(initialState, {
      protocolVersion: 14,
      health: {...health, characters},
      confirmations: [],
      pairings: [],
      turns: [],
    }),
    page,
  );
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

  it("previews a chosen file over the page it was chosen from, keeping its text only while she can be added from it; adding her opens her page and lets the file go, and a refusal or a write that failed stays on the preview in the daemon's words", () => {
    const text = '{"format": "project02.character.v1"}';
    const from: SettingsPage = {kind: 'character', characterId: 'mira'};
    const shown = characterPreviewed(
      opened(),
      {name: 'nova.json', text},
      novaFile,
    );

    expect(pageOf(shown)).toEqual({
      kind: 'add',
      fileName: 'nova.json',
      text,
      preview: novaFile,
      from,
    });

    const notOne = {
      status: 'refused',
      reason: 'invalid',
      message: 'This file is not a character file this app can read.',
    } as const;

    // Another file chosen from the preview goes back where the first came from.
    expect(
      pageOf(characterPreviewed(shown, {name: 'notes.json', text}, notOne)),
    ).toEqual({kind: 'add', fileName: 'notes.json', preview: notOne, from});
    expect(characterFileRefusal(64 * 1024)).toBeUndefined();
    expect(characterFileRefusal(64 * 1024 + 1)).toBe(
      'This file is too large to be a character file.',
    );

    const asked = {kind: 'add', fileName: 'nova.json', text, from} as const;
    const builtIn =
      'This character comes with the app, so a file cannot add or change her.';
    const refused = characterAddEnded(
      shown,
      {...asked, preview: novaFile},
      {status: 'refused', reason: 'built_in', message: builtIn},
    );
    const unreached = {
      status: 'failed',
      message: 'The app could not be reached.',
    } as const;

    expect(pageOf(refused)).toEqual({...pageOf(shown), problem: builtIn});
    expect(
      pageOf(
        characterAddEnded(shown, {...asked, preview: novaFile}, unreached),
      ),
    ).toMatchObject({kind: 'add', problem: 'The app could not be reached.'});
    expect(
      pageOf(
        characterAddEnded(
          refused,
          {...asked, preview: novaFile},
          {status: 'updated', characterId: 'nova'},
        ),
      ),
    ).toEqual({kind: 'character', characterId: 'nova'});

    // An answer is its own preview's alone. One that finds another file
    // previewed, or the window elsewhere, leaves what is shown as it is:
    // she is in the roster when she was added, and what kept her out is a
    // notice. A file chosen with no window open is not shown.
    const another = characterPreviewed(
      shown,
      {name: 'aria.json', text: '{"format": "project02.character.v1", "n": 2}'},
      novaFile,
    );
    const elsewhere = opened();

    for (const left of [another, elsewhere]) {
      expect(
        characterAddEnded(
          left,
          {...asked, preview: novaFile},
          {status: 'added', characterId: 'nova'},
        ),
      ).toBe(left);
      expect(
        characterAddEnded(left, {...asked, preview: novaFile}, unreached),
      ).toEqual({...left, notices: ['The app could not be reached.']});
    }

    expect(
      characterPreviewed(initialState, {name: 'nova.json', text}, novaFile),
    ).toBe(initialState);
  });

  it('leaves every page of a character who is gone, removed here or missing from the roster the daemon says, and the page a preview goes back to; keeps the page of one on her way; and says in her confirmation why a removal did not land', () => {
    const asking = windowOn({kind: 'remove', characterId: 'nova'}, [
      ...health.characters,
      nova,
    ]);
    const builtIn =
      'This character comes with the app, so she cannot be removed.';

    expect(
      pageOf(
        characterRemoveEnded(asking, 'nova', {
          status: 'refused',
          reason: 'built_in',
          message: builtIn,
        }),
      ),
    ).toEqual({kind: 'remove', characterId: 'nova', problem: builtIn});
    expect(
      characterRemoveEnded(asking, 'mira', {status: 'failed', message: 'No.'}),
    ).toBe(asking);
    expect(
      pageOf(characterRemoveEnded(asking, 'nova', {status: 'removed'})),
    ).toEqual({kind: 'you'});

    const without = (page: SettingsPage) =>
      pageOf(
        applyEvent(windowOn(page, [...health.characters, nova]), {
          kind: 'health_changed',
          health,
        }),
      );
    const preview: SettingsPage = {
      kind: 'add',
      fileName: 'lyra.json',
      preview: {...novaFile, id: 'lyra', displayName: 'Lyra'},
      from: {kind: 'feature', characterId: 'nova', pluginId: 'reply-style'},
    };

    expect(without({kind: 'character', characterId: 'nova'})).toEqual({
      kind: 'you',
    });
    expect(
      without({kind: 'bot', target: characterTarget('nova'), from: 'telegram'}),
    ).toEqual({kind: 'you'});
    expect(without(preview)).toEqual({...preview, from: {kind: 'you'}});
    expect(without({kind: 'bot', target: home, from: 'telegram'})).toEqual({
      kind: 'bot',
      target: home,
      from: 'telegram',
    });
    expect(without({...preview, from: {kind: 'telegram'}})).toEqual({
      ...preview,
      from: {kind: 'telegram'},
    });

    // A reconnect that finds her gone leaves her page the same way.
    expect(
      pageOf(
        installSnapshot(asking, {
          protocolVersion: 14,
          health,
          confirmations: [],
          pairings: [],
          turns: [],
        }),
      ),
    ).toEqual({kind: 'you'});

    // With the window closed, the roster is all that changes.
    expect(
      applyEvent(settingsClosed(asking), {kind: 'health_changed', health})
        .settings,
    ).toBeUndefined();

    // Added here before the roster lists her, she is on her way: her page stays.
    const coming = windowOn(
      {kind: 'character', characterId: 'nova'},
      health.characters,
    );

    expect(
      pageOf(applyEvent(coming, {kind: 'health_changed', health})),
    ).toEqual({kind: 'character', characterId: 'nova'});
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
