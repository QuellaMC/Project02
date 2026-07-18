/**
 * Credential redaction over free text: key-name classification and
 * pattern scrubbing for authorization headers, secrets, and URI
 * credentials. Split out of json-boundary.ts so the security-sensitive
 * tables are auditable on their own (migration plan S-10).
 */
const credentialMetricKeys = new Set([
  'acceptedpredictiontokens',
  'inputtokens',
  'outputtokens',
  'prompttokens',
  'prompttokensdetails',
  'reasoningtokens',
  'rejectedpredictiontokens',
  'tokencount',
  'tokenusage',
  'totaltokens',
]);

const exactCredentialKeys = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'clientsecret',
  'privatekey',
  'accesskey',
  'secretkey',
  'sessionkey',
]);

export function isJsonBoundaryCredentialKey(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]/gu, '');

  if (credentialMetricKeys.has(normalized)) {
    return false;
  }

  return (
    exactCredentialKeys.has(normalized) ||
    normalized.includes('apikey') ||
    normalized.includes('accesstoken') ||
    normalized.includes('refreshtoken') ||
    normalized.includes('clientsecret') ||
    normalized.includes('secretaccesskey') ||
    normalized.includes('privatekey') ||
    normalized.includes('accesskey') ||
    normalized.includes('sessionkey') ||
    normalized.includes('password') ||
    normalized.includes('passphrase') ||
    normalized.includes('credential') ||
    normalized.endsWith('token') ||
    normalized.endsWith('secret')
  );
}

const authorizationHeaderPattern =
  /\b(Authorization|Proxy-Authorization)(\s*[:=]\s*)[^\r\n]+/giu;
const authenticationSchemePattern = /\b(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/giu;
const cookieHeaderPattern = /\b(Cookie|Set-Cookie)(\s*[:=]\s*)[^\r\n]+/giu;
const secretKeyValuePattern =
  /(["']?)([A-Za-z0-9_.-]*(?:api[_.-]?key|access[_.-]?token|refresh[_.-]?token|client[_.-]?secret|secret[_.-]?access[_.-]?key|private[_.-]?key|access[_.-]?key|session[_.-]?key|password|passphrase|credential|secret|token)[A-Za-z0-9_.-]*)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^&#\s,;}]+)/giu;
const secretQueryValuePattern =
  /([?&][A-Za-z0-9_.-]*(?:api[_.-]?key|access[_.-]?token|refresh[_.-]?token|client[_.-]?secret|secret[_.-]?access[_.-]?key|private[_.-]?key|access[_.-]?key|session[_.-]?key|password|passphrase|credential|secret|token)[A-Za-z0-9_.-]*=)[^&#\s]+/giu;
const uriCredentialsPattern = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]+)@/giu;

export function redactJsonBoundaryText(value: string): string {
  return value
    .replace(authorizationHeaderPattern, '$1$2[redacted]')
    .replace(authenticationSchemePattern, '$1 [redacted]')
    .replace(cookieHeaderPattern, '$1$2[redacted]')
    .replace(secretKeyValuePattern, redactSecretKeyValueMatch)
    .replace(secretQueryValuePattern, '$1[redacted]')
    .replace(uriCredentialsPattern, '$1[redacted]@');
}

function redactSecretKeyValueMatch(
  _match: string,
  keyQuote: string,
  key: string,
  separator: string,
  rawValue: string,
): string {
  const valueQuote = rawValue.startsWith('"')
    ? '"'
    : rawValue.startsWith("'")
      ? "'"
      : '';

  return `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[redacted]${valueQuote}`;
}
