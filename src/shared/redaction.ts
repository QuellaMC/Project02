/** Field names classify; value text is never scanned for secret-like shapes. */
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
