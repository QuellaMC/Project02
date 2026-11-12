import {describe, expect, it} from 'vitest';

import type {
  AppPreviewOutcome,
  ConfigView,
  PhoneApp,
  PhoneOutcome,
  RuntimeConfigSectionInspectShape,
  StoreApp,
  StoreOutcome,
} from '@project02/wire/contract';
import {
  appFileAdded,
  appFilePreviewed,
  appFileRefusal,
  appGiven,
  appRemoveEnded,
  appShownOf,
  appsCharacterOf,
  appsFooter,
  askToInstallRow,
  catalogCharacterOf,
  catalogRead,
  hasPhone,
  herPhoneRead,
  replacesLine,
  storeRows,
  stripOf,
  type AppPreview,
} from './her-apps.ts';
import {characterTarget, settingsOpened, windowPage} from './settings.ts';
import {
  initialState,
  type Settings,
  type SettingsPage,
  type WebState,
} from './store.ts';

/** An app on her phone, from the App Store unless `shape` says otherwise. */
function app(
  id: string,
  name: string,
  shape: Partial<PhoneApp> = {},
): PhoneApp {
  return {
    id,
    name,
    summary: `${name}, on her phone`,
    version: '1.0.0',
    source: 'catalog',
    icon: 'doc',
    tint: 'gray',
    wakes: false,
    mayWake: true,
    views: [{id: 'all', title: 'All', icon: 'doc'}],
    opensOn: 'all',
    ...shape,
  };
}

const clock = app('clock', 'Clock', {
  source: 'built_in',
  icon: 'clock',
  tint: 'graphite',
  wakes: true,
});
const appStore = app('store', 'App Store', {
  source: 'built_in',
  icon: 'bag',
  tint: 'blue',
});
const reminders = app('reminders', 'Reminders', {
  icon: 'list',
  tint: 'orange',
  wakes: true,
});
const notes = app('notes', 'Notes', {source: 'file', version: '2.0.0'});

/** Her phone as a read gives it: the Clock, Reminders from the App Store, Notes from a file, and the App Store last. */
const phone: PhoneOutcome = {
  status: 'ok',
  apps: [clock, reminders, notes, appStore],
  ringing: [],
};

/** An app of the App Store as it says it stands on her phone. */
function listed(
  id: string,
  name: string,
  status: StoreApp['status'],
  summary = `${name}, in the App Store`,
): StoreApp {
  return {
    id,
    name,
    summary,
    icon: 'doc',
    tint: 'gray',
    version: '1.1.0',
    changes: 'Better.',
    wakes: false,
    itMay: ['Keep its own data'],
    status,
  };
}

/** A live tab with the window open on `page`, her phone and the App Store's apps for Mira as given. */
function windowOn(
  page: SettingsPage,
  reads: {readonly phone?: PhoneOutcome; readonly store?: StoreOutcome} = {},
): WebState {
  let state = settingsOpened(initialState, page);

  if (reads.phone !== undefined) {
    state = herPhoneRead(state, 'mira', reads.phone);
  }

  return reads.store === undefined
    ? state
    : catalogRead(state, 'mira', reads.store);
}

function settingsOf(state: WebState): Settings {
  if (state.settings === undefined) {
    throw new Error('The window is closed.');
  }

  return state.settings;
}

const herPage: SettingsPage = {kind: 'character', characterId: 'mira'};
const mira = {characterId: 'mira', name: 'Mira'};

describe('her apps in the settings window', () => {
  it("draws her Apps group: an icon for each app on her phone but the App Store, in her phone's order, why her phone could not be read in the daemon's words, nothing before it was read, and where apps come from, saying that she asks first only while she may", () => {
    expect(stripOf(phone)).toEqual({
      kind: 'apps',
      apps: [clock, reminders, notes],
    });
    expect(
      stripOf({status: 'failed', message: 'Her phone could not be read.'}),
    ).toEqual({kind: 'unread', message: 'Her phone could not be read.'});
    expect(stripOf(undefined)).toBeUndefined();
    expect(appsFooter(true)).toBe(
      'Apps come from the App Store. She can find them herself, and asks before installing one.',
    );
    expect(appsFooter(false)).toBe('Apps come from the App Store.');
  });

  it("knows from her view whether her settings give her a phone, and her Ask to Install Apps is a field of her phone's", () => {
    const phoneSection = (
      enabled: boolean,
    ): RuntimeConfigSectionInspectShape => ({
      namespace: 'plugins',
      id: 'phone',
      displayName: 'Phone',
      version: '1.0.0',
      enabled,
      enabledSource: 'default',
      activation: {
        enabled,
        status: enabled ? 'active' : 'disabled',
        reasons: [],
      },
      setup: {ready: true},
      fields: [],
      layout: [],
      diagnostics: [],
    });
    const view = (
      sections: readonly RuntimeConfigSectionInspectShape[],
    ): Extract<ConfigView, {status: 'ok'}> => ({
      status: 'ok',
      fingerprint: 'f1',
      diagnostics: [],
      model: {ready: true},
      project02: [],
      sections,
    });

    expect(hasPhone(view([phoneSection(true)]))).toBe(true);
    expect(hasPhone(view([phoneSection(false)]))).toBe(false);
    expect(hasPhone(view([]))).toBe(false);
    expect(askToInstallRow('mira')).toEqual({
      target: characterTarget('mira'),
      place: {
        kind: 'field',
        namespace: 'plugins',
        id: 'phone',
        name: 'askToInstall',
      },
    });
  });

  it("draws an app's page: whose phone it is on, its version and where it came from, for an app she came with, one from the App Store and one from a file; what letting it wake her does, for the Clock and for another app that wakes her; an update only when the App Store says it has a newer version; and Remove App for every app but one she came with", () => {
    const settings = settingsOf(
      windowOn(herPage, {
        phone,
        store: {
          status: 'ok',
          apps: [
            listed('reminders', 'Reminders', 'update'),
            listed('notes', 'Notes', 'installed'),
          ],
        },
      }),
    );

    expect(appShownOf(settings, mira, 'clock')).toEqual({
      app: clock,
      line: "On Mira's phone. Version 1.0.0, built in.",
      wake: 'Her alarms and timers can start a moment of her own.',
      removable: false,
    });
    expect(appShownOf(settings, mira, 'reminders')).toEqual({
      app: reminders,
      line: "On Mira's phone. Version 1.0.0, from the App Store.",
      wake: 'What she sets in it can start a moment of her own.',
      update: '1.1.0',
      removable: true,
    });
    expect(appShownOf(settings, mira, 'notes')).toEqual({
      app: notes,
      line: "On Mira's phone. Version 2.0.0, from a file.",
      removable: true,
    });
    expect(appShownOf(settings, mira, 'chess')).toBeUndefined();

    // A store that could not be read offers no update, and says nothing here.
    const unread = settingsOf(
      windowOn(herPage, {
        phone,
        store: {status: 'failed', message: 'The App Store cannot be reached.'},
      }),
    );

    expect(appShownOf(unread, mira, 'reminders')).not.toHaveProperty('update');
  });

  it('ends each row of Get More Apps in Get, Update or Installed as the App Store says the app stands on her phone, and finds apps by their names and summaries whatever their case, every one while the search is empty', () => {
    const apps = [
      listed('reminders', 'Reminders', 'not_on_phone', 'Things to do'),
      listed('notes', 'Notes', 'update', 'Write things down'),
      listed('weather', 'Weather', 'installed', 'Rain or sun'),
    ];
    const found = (search: string) =>
      storeRows(apps, search).map(({app: shown, end}) => [shown.id, end]);

    expect(found('')).toEqual([
      ['reminders', 'Get'],
      ['notes', 'Update'],
      ['weather', 'Installed'],
    ]);
    expect(found('  WEATH ')).toEqual([['weather', 'Installed']]);
    expect(found('things')).toEqual([
      ['reminders', 'Get'],
      ['notes', 'Update'],
    ]);
    expect(found('chess')).toEqual([]);
  });

  it("offers an app from a file: the offer keeps the file's text only while it holds an app and says the version it replaces when it replaces one; a file too large to be an app is never sent; adding it opens its page, a refusal stays on the offer, and an offer the person left hears it as a notice", () => {
    const text = 'export const manifest = {};';
    const offer: AppPreview = {
      status: 'ok',
      id: 'notes',
      name: 'Notes',
      summary: 'Notes, quietly',
      icon: 'doc',
      tint: 'gray',
      version: '2.0.0',
      wakes: false,
      itMay: ['Keep its own data'],
    };
    const getApps: SettingsPage = {kind: 'get-apps', characterId: 'mira'};
    const shown = appFilePreviewed(
      windowOn(getApps),
      'mira',
      {name: 'notes.js', text},
      offer,
    );
    const asked = {
      kind: 'app-file',
      characterId: 'mira',
      fileName: 'notes.js',
      text,
      preview: offer,
    } as const;

    expect(windowPage(shown)).toEqual(asked);
    expect(replacesLine(offer)).toBeUndefined();
    expect(replacesLine({...offer, replaces: '1.0.0'})).toBe(
      'This replaces version 1.0.0 on her phone. What it kept stays.',
    );

    const notAnApp: AppPreviewOutcome = {
      status: 'refused',
      reason: 'not_an_app',
      message: 'Manifest name must not be blank.',
    };

    expect(
      windowPage(
        appFilePreviewed(shown, 'mira', {name: 'blank.js', text}, notAnApp),
      ),
    ).toEqual({
      kind: 'app-file',
      characterId: 'mira',
      fileName: 'blank.js',
      preview: notAnApp,
    });
    expect(
      appFilePreviewed(initialState, 'mira', {name: 'notes.js', text}, offer),
    ).toBe(initialState);
    expect(appFileRefusal(256 * 1024)).toBeUndefined();
    expect(appFileRefusal(256 * 1024 + 1)).toBe(
      'This file is too large to be an app.',
    );

    const added = {status: 'ok', app: notes} as const;
    const clockId = {
      status: 'refused',
      reason: 'comes_with_phone',
      message: 'The phone comes with an app of the same id, Clock.',
    } as const;

    expect(windowPage(appFileAdded(shown, asked, added))).toEqual({
      kind: 'app',
      characterId: 'mira',
      appId: 'notes',
    });
    expect(windowPage(appFileAdded(shown, asked, clockId))).toEqual({
      ...asked,
      problem: clockId.message,
    });

    const left = windowOn(getApps);

    expect(appFileAdded(left, asked, added)).toBe(left);
    expect(appFileAdded(left, asked, clockId).notices).toEqual([
      clockId.message,
    ]);
  });

  it("lands the person's acts on her apps: given by Get or Update, the app stands Installed and its update goes, and a refusal is a notice; removed, its page gives way to hers, as it does when a read of her phone no longer lists it or cannot read it; and a removal refused stays on its page, asking, or is a notice once the person left", () => {
    const store: StoreOutcome = {
      status: 'ok',
      apps: [
        listed('reminders', 'Reminders', 'update'),
        listed('chess', 'Chess', 'not_on_phone'),
      ],
    };
    const remindersPage = {
      kind: 'app',
      characterId: 'mira',
      appId: 'reminders',
    } as const;
    const open = windowOn(remindersPage, {phone, store});
    const given = appGiven(open, 'mira', 'reminders', {
      status: 'ok',
      app: {...reminders, version: '1.1.0'},
      replaced: '1.0.0',
    });

    expect(settingsOf(given).catalogs.get('mira')).toEqual({
      status: 'ok',
      apps: [
        listed('reminders', 'Reminders', 'installed'),
        listed('chess', 'Chess', 'not_on_phone'),
      ],
    });
    expect(
      appGiven(open, 'mira', 'chess', {
        status: 'refused',
        reason: 'not_as_listed',
        message: 'Chess in the App Store does not match its listing.',
      }).notices,
    ).toEqual(['Chess in the App Store does not match its listing.']);

    const asking = windowOn({...remindersPage, removing: {}}, {phone});
    const refusal = {
      status: 'refused',
      reason: 'unknown_app',
      message: 'There is no app "reminders" on her phone.',
    } as const;

    expect(
      windowPage(appRemoveEnded(asking, 'mira', 'reminders', refusal)),
    ).toEqual({...remindersPage, removing: {problem: refusal.message}});
    expect(
      appRemoveEnded(windowOn(herPage), 'mira', 'reminders', refusal).notices,
    ).toEqual([refusal.message]);
    expect(
      windowPage(appRemoveEnded(asking, 'mira', 'reminders', {status: 'ok'})),
    ).toEqual(herPage);
    expect(
      windowPage(
        appRemoveEnded(windowOn(herPage), 'mira', 'reminders', {status: 'ok'}),
      ),
    ).toEqual(herPage);

    const without: PhoneOutcome = {
      ...phone,
      apps: [clock, notes, appStore],
    };

    expect(windowPage(herPhoneRead(asking, 'mira', without))).toEqual(herPage);
    expect(
      windowPage(
        herPhoneRead(asking, 'mira', {
          status: 'refused',
          reason: 'no_phone',
          message: 'Mira has no phone: her settings switch it off.',
        }),
      ),
    ).toEqual(herPage);
    expect(windowPage(herPhoneRead(asking, 'nova', without))).toEqual({
      ...remindersPage,
      removing: {},
    });
    expect(herPhoneRead(initialState, 'mira', phone)).toBe(initialState);
    expect(catalogRead(initialState, 'mira', store)).toBe(initialState);
  });

  it("reads her phone for every page about her apps, and the App Store's apps for her for Get More Apps and an app's page", () => {
    const pages: readonly SettingsPage[] = [
      herPage,
      {kind: 'remove', characterId: 'mira'},
      {kind: 'app', characterId: 'mira', appId: 'clock'},
      {kind: 'get-apps', characterId: 'mira'},
      {
        kind: 'app-file',
        characterId: 'mira',
        fileName: 'notes.js',
        preview: {status: 'failed', message: 'No.'},
      },
      {kind: 'feature', characterId: 'mira', pluginId: 'reply-style'},
      {kind: 'you'},
    ];

    expect(pages.map(appsCharacterOf)).toEqual([
      'mira',
      'mira',
      'mira',
      'mira',
      'mira',
      undefined,
      undefined,
    ]);
    expect(pages.map(catalogCharacterOf)).toEqual([
      undefined,
      undefined,
      'mira',
      'mira',
      undefined,
      undefined,
      undefined,
    ]);
    expect(appsCharacterOf(undefined)).toBeUndefined();
  });
});
