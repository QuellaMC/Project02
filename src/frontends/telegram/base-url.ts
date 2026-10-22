/**
 * Whether a value can be a server's base URL: http or https, with nothing
 * an endpoint path could not follow — a query or fragment would sit before
 * it and silently move where every request lands — and no userinfo, which
 * Node's fetch refuses, so it would surface as a fake outage instead of
 * the setting to fix.
 */
export function isHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * The rule as a refusal states it, after the setting's name. A refusal
 * never echoes the value: a mistyped URL can carry a credential, and the
 * message reaches logs and durable evidence.
 */
export const httpBaseUrlRule =
  'an absolute http:// or https:// address with no embedded credentials, query, or fragment';

/** The endpoint at `path` under a base, given with or without its trailing slash. */
export function endpointUnder(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);

  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/${path}`;

  return url.href;
}
