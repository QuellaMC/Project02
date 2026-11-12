/**
 * Apps as the App Store serves them, for a test to publish on the catalog
 * server: an app's one file, its entry in the catalog with that file's
 * SHA-256, and a catalog of apps published where its rule puts each file;
 * with the apps the tests publish, Reminders and quiet ones, and Lookup,
 * which reaches the internet.
 */
import {createHash} from 'node:crypto';

import type {CatalogServer} from './catalog-server.ts';

/** An app as its one file says it: its manifest, and its functions beside it. */
export type App = {
  readonly manifest: {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    readonly version: string;
    readonly icon: string;
    readonly tint: string;
    readonly wakes: boolean;
    readonly reaches?: readonly string[];
    readonly account?: string;
    readonly views: readonly object[];
    readonly opensOn: string;
    readonly actions: readonly object[];
  };
  readonly script: string;
};

/** Reminders, which keeps what she adds and says it wakes her. */
export const reminders: App = {
  manifest: {
    id: 'reminders',
    name: 'Reminders',
    summary: 'Things to do, on a day and time',
    version: '1.0.0',
    icon: 'list',
    tint: 'orange',
    wakes: true,
    views: [{id: 'all', title: 'All', icon: 'list'}],
    opensOn: 'all',
    actions: [
      {
        name: 'add',
        description: 'Add a reminder.',
        did: 'Added a reminder',
        view: 'all',
        input: {
          type: 'object',
          properties: {title: {type: 'string'}},
          required: ['title'],
          additionalProperties: false,
        },
      },
    ],
  },
  script: `export function screen() {
  const kept = phone.storage.get('reminders') ?? [];

  return {items: kept.length === 0
    ? [{kind: 'text', text: 'No Reminders'}]
    : [{kind: 'list', rows: kept.map((title) => ({title}))}]};
}

export function add({title}) {
  phone.storage.set('reminders', [...(phone.storage.get('reminders') ?? []), title]);

  return {title};
}`,
};

/**
 * Lookup, which reaches Tavily's host on the person's Tavily account, and
 * Open-Meteo's, a host of no account. `fetch_all` makes the requests it is
 * given, in order, and answers what came of each, the answer or the
 * sentence of its failure, which it keeps; its screen shows what it kept,
 * and what its own try to reach the internet came to.
 */
export const lookup: App = {
  manifest: {
    id: 'lookup',
    name: 'Lookup',
    summary: 'Looks things up',
    version: '1.0.0',
    icon: 'globe',
    tint: 'blue',
    wakes: false,
    reaches: ['api.tavily.com', 'api.open-meteo.com'],
    account: 'tavily',
    views: [{id: 'found', title: 'Found', icon: 'globe'}],
    opensOn: 'found',
    actions: [
      {
        name: 'fetch_all',
        description: 'Make these requests.',
        did: 'Looked things up',
        view: 'found',
        input: {
          type: 'object',
          properties: {requests: {type: 'array'}},
          required: ['requests'],
          additionalProperties: false,
        },
      },
    ],
  },
  script: `export function screen() {
  let tried = 'reached';

  try {
    phone.net.fetch({url: 'https://api.open-meteo.com/v1/forecast'});
  } catch (error) {
    tried = String(error);
  }

  return {items: [
    {kind: 'text', text: phone.storage.get('found') ?? 'Nothing yet'},
    {kind: 'text', text: tried},
  ]};
}

export function fetch_all({requests}) {
  const came = requests.map((request) => {
    try {
      return phone.net.fetch(request);
    } catch (error) {
      if (error.name !== 'Error') {
        throw error;
      }

      return {error: error.message};
    }
  });

  phone.storage.set('found', JSON.stringify(came));

  return came;
}`,
};

/** An app of `name` that shows a line and does nothing, at `version`. */
export function quiet(id: string, name: string, version: string): App {
  return {
    manifest: {
      id,
      name,
      summary: `${name}, quietly`,
      version,
      icon: 'doc',
      tint: 'gray',
      wakes: false,
      views: [{id: 'all', title: 'All', icon: 'doc'}],
      opensOn: 'all',
      actions: [],
    },
    script: `export function screen() { return {items: [{kind: 'text', text: 'No ${name}'}]}; }`,
  };
}

/** The app's one file: its manifest, exported, then its functions. */
export function fileOf(app: App): string {
  return `export const manifest = ${JSON.stringify({format: 'project02.app.v1', ...app.manifest})};\n\n${app.script}\n`;
}

/** The catalog's entry of `app`, listing the file whose text is `listed`, its own unless the test says otherwise. */
export function entryOf(app: App, listed = fileOf(app)): object {
  const {id, name, summary, icon, tint, version, wakes, reaches, account} =
    app.manifest;

  return {
    id,
    name,
    summary,
    icon,
    tint,
    version,
    changes: 'The first version.',
    wakes,
    reaches,
    account,
    sha256: createHash('sha256').update(listed).digest('hex'),
  };
}

/** The catalog of `apps`, in their order, each beside its file where the catalog's rule puts it; an entry given with an app lists in its place. */
export function publish(
  catalog: CatalogServer,
  ...apps: readonly (readonly [App, object?])[]
): void {
  catalog.publish(
    'catalog.json',
    JSON.stringify({
      format: 'project02.catalog.v1',
      apps: apps.map(([app, entry]) => entry ?? entryOf(app)),
    }),
  );

  for (const [app] of apps) {
    catalog.publish(
      `apps/${app.manifest.id}/${app.manifest.version}.js`,
      fileOf(app),
    );
  }
}
