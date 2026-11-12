// Web Search: the web searched through Tavily, on the person's own account,
// whose key her phone's caller sends with each search: the app never holds
// it. She searches for something; the app keeps what came up, which its
// screen shows, since a screen never reaches the internet.
//
// It keeps, in phone.storage, `search`: the `query` searched last; when it
// was `searched`, in milliseconds since the epoch, which names the page its
// screen shows; and its `results`, each with its `title`, its `url`, the
// `site` it is from and a few `lines` of it.

export const manifest = {
  format: 'project02.app.v1',
  id: 'search',
  name: 'Web Search',
  summary: 'Look things up on the web',
  version: '1.0.0',
  icon: 'magnifier',
  tint: 'mint',
  wakes: false,
  reaches: ['api.tavily.com'],
  account: 'tavily',
  views: [{id: 'search', title: 'Web Search', icon: 'magnifier'}],
  opensOn: 'search',
  actions: [
    {
      name: 'search',
      description:
        'Search the web for something and read what comes up: the pages that match it best, each with its title, its address and a few lines of it.',
      did: 'Searched the web',
      view: 'search',
      input: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            pattern: '^[^\\n\\r]*\\S[^\\n\\r]*$',
            maxLength: 400,
            description:
              'What to search for, in one line, as you would type it into a search box: how long to steep green tea.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  ],
};

// Tavily's search, asked for the pages that match best: a basic search, which
// is one credit of the person's plan.
const SEARCH = 'https://api.tavily.com/search';
const RESULTS = 5;
// The most characters a result's lines keep, their ellipsis among them.
const LINES = 400;
// The longest address a row of a screen takes.
const ADDRESS_LENGTH = 2048;
// An address a row of a screen takes, and its host: what follows its scheme,
// without a user before it or a port after it.
const ADDRESS = /^https?:\/\/(?:[^/?#@]*@)?([^/?#:]*)/;
// What a search Tavily refused says, by the status it refused it with.
const REFUSALS = {
  401: 'Tavily did not take the key in Settings.',
  429: 'Tavily says there were too many searches at once. Try again in a moment.',
  432: 'The Tavily account in Settings has used up its searches.',
  433: 'The Tavily account in Settings has used up its searches.',
};

export function screen() {
  const last = phone.storage.get('search');

  if (last === null) {
    return {items: [{kind: 'text', text: 'No Searches'}]};
  }

  const {query, searched, results} = last;

  return {
    items: [
      {kind: 'field', text: query, icon: 'magnifier'},
      results.length > 0
        ? {kind: 'list', rows: results.map(row)}
        : {kind: 'text', text: 'No Results'},
    ],
    // Each search a page of its own, so what came up is never taken for rows
    // the search before it gained.
    page: String(searched),
  };
}

// The web searched for `query`: what came up is kept in place of the search
// before, and told her, each result with its title, its address and its
// lines.
export function search({query}) {
  const asked = query.trim();
  const results = resultsOf(
    phone.net.fetch({
      url: SEARCH,
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({
        query: asked,
        search_depth: 'basic',
        max_results: RESULTS,
      }),
    }),
  );

  phone.storage.set('search', {
    query: asked,
    searched: phone.time.now(),
    results,
  });
  return {
    query: asked,
    results: results.map(({title, url, lines}) => ({title, url, lines})),
  };
}

// What came up, as Tavily answered the search: each result a row can show,
// with the site it is from and its lines. Refused, in the app's words, when
// Tavily refused the search, by its status, or did not answer one.
function resultsOf({status, body}) {
  if (status !== 200) {
    throw new Error(
      REFUSALS[status] ??
        `The search did not work: Tavily answered with status ${status}.`,
    );
  }

  const results = parsed(body)?.results;

  if (!Array.isArray(results)) {
    throw new Error(
      'The search did not work: Tavily did not answer as it should.',
    );
  }
  return results.filter(showable).map(({title, url, content}) => ({
    title,
    url,
    site: siteOf(url),
    lines: linesOf(content),
  }));
}

// A result as a row: the site it is from above its title, its lines below,
// and its address, which draws the title as a link.
function row({title, url, site, lines}) {
  return {caption: site, title, subtitle: lines, url};
}

// Whether a result of Tavily's can be shown as a row: its title, its address
// and its lines are text, and its address is one a row takes.
function showable(result) {
  const {title, url, content} = result ?? {};

  return (
    typeof title === 'string' &&
    typeof content === 'string' &&
    typeof url === 'string' &&
    ADDRESS.test(url) &&
    [...url].length <= ADDRESS_LENGTH
  );
}

// The site an address is on: its host, without a leading "www.".
function siteOf(url) {
  return ADDRESS.exec(url)[1].replace(/^www\./, '');
}

// A result's lines, Tavily's own, with their white space made single and,
// past LINES characters, cut at a word, or inside one when no space comes
// before, with an ellipsis.
function linesOf(content) {
  const single = content.replace(/\s+/g, ' ').trim();
  const characters = [...single];

  if (characters.length <= LINES) {
    return single;
  }

  const head = characters.slice(0, LINES).join('');
  const word = head.lastIndexOf(' ');
  const kept =
    word === -1 ? characters.slice(0, LINES - 1).join('') : head.slice(0, word);

  return `${kept}…`;
}

// `text` read as JSON, or undefined when it is not JSON.
function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
