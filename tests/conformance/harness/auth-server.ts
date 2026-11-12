/**
 * OpenAI's sign-in on loopback, where the daemon's switch names it in
 * OpenAI's place, answering as OpenAI does: a code for each start, "not
 * yet" to every ask until the test approves it as the person would on
 * OpenAI's page, then the tokens it is exchanged for, and a refresh that
 * trades the newest refresh token for new tokens and refuses any other. It
 * keeps every request with its fields, and every secret it gave.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {text} from 'node:stream/consumers';

import {servedOnLoopback} from './server.ts';
import {attachEvidence} from './wait.ts';

/** A request as it came: where, and its fields, sent as JSON or as a form. */
export type AuthRequest = {
  readonly path: string;
  readonly fields: Readonly<Record<string, unknown>>;
};

/** Who the person signs in as: an OpenAI account, with a ChatGPT plan or none. */
export type Account = {
  readonly email: string;
  readonly chatgpt?: {readonly accountId: string; readonly plan: string};
};

/** A code as the server gave it: what the person types, and when it stops working. */
export type IssuedCode = {
  readonly userCode: string;
  readonly expiresAt: number;
};

export type AuthServer = {
  /** The daemon's environment that names this server in OpenAI's place. */
  readonly env: {readonly PROJECT02_TEST_OPENAI_AUTH: string};
  /** Where the person types the code. */
  readonly page: string;
  /** Where OpenAI sends the person once the code is approved. */
  readonly callback: string;
  readonly requests: readonly AuthRequest[];
  /** The newest code it gave. */
  readonly code: () => IssuedCode | undefined;
  /** The person approves the newest code, signing in as `account`. */
  readonly approve: (account?: Account) => void;
  /** Every token, claim and code that proves who signed in, which nothing a client reads may hold. */
  readonly secrets: () => readonly string[];
};

/** Codex's public OAuth client, which every sign-in names. */
export const codexClient = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** Sam, on the Plus plan. */
export const sam = {
  email: 'sam@example.com',
  chatgpt: {accountId: 'acct-sam', plan: 'Plus'},
} as const satisfies Account;

/**
 * A JWT with this payload and no signature worth checking: an access token
 * with the moment it runs out, or an ID token naming the account.
 */
function jwt(payload: object): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  return `${encode({alg: 'none'})}.${encode(payload)}.signature`;
}

/** The moment an access token of this server runs out: years on, whatever the clock says. */
const accessExpiry = 2_000_000_000;

/**
 * The server, its codes lasting `codeLifetimeMs` from when each is given:
 * fifteen minutes unless a test gives a code already past its time.
 */
export async function startAuthServer(
  codeLifetimeMs = 15 * 60 * 1000,
): Promise<AuthServer> {
  const requests: AuthRequest[] = [];
  const secrets: string[] = [];
  const codes: (IssuedCode & {readonly deviceAuthId: string})[] = [];
  let approved:
    {readonly deviceAuthId: string; readonly account: Account} | undefined;
  let grant:
    | {
        readonly code: string;
        readonly verifier: string;
        readonly account: Account;
      }
    | undefined;
  let refreshToken:
    {readonly token: string; readonly account: Account} | undefined;
  let issued = 0;
  /** A new secret of `kind`, kept to look for later. */
  const secret = (kind: string): string => {
    issued += 1;

    const made = `${kind}-${String(issued)}-secret`;

    secrets.push(made);

    return made;
  };
  /** New tokens for `account`, its refresh token the only one the server takes from now on. */
  const tokens = (account: Account, withIdToken: boolean): object => {
    const accessToken = jwt({exp: accessExpiry, jti: secret('access')});
    const idToken = jwt({
      email: account.email,
      jti: secret('id'),
      ...(account.chatgpt === undefined
        ? {}
        : {
            'https://api.openai.com/auth': {
              chatgpt_account_id: account.chatgpt.accountId,
              chatgpt_plan_type: account.chatgpt.plan,
            },
          }),
    });

    refreshToken = {token: secret('refresh'), account};
    secrets.push(accessToken, idToken);

    return {
      access_token: accessToken,
      refresh_token: refreshToken.token,
      ...(withIdToken ? {id_token: idToken} : {}),
      expires_in: 864_000,
    };
  };
  const answer = (path: string, fields: Readonly<Record<string, unknown>>) => {
    switch (path) {
      case '/api/accounts/deviceauth/usercode': {
        const code = {
          deviceAuthId: secret('device'),
          userCode: `CODE-${String(codes.length + 1)}`,
          expiresAt: Date.now() + codeLifetimeMs,
        };

        codes.push(code);

        return {
          status: 200,
          body: {
            device_auth_id: code.deviceAuthId,
            user_code: code.userCode,
            interval: '0.05',
            expires_at: new Date(code.expiresAt).toISOString(),
          },
        };
      }
      case '/api/accounts/deviceauth/token': {
        // OpenAI answers 403 until the person approves the code.
        if (
          approved === undefined ||
          fields['device_auth_id'] !== approved.deviceAuthId
        ) {
          return {status: 403, body: {}};
        }

        grant = {
          code: secret('authorization'),
          verifier: secret('verifier'),
          account: approved.account,
        };
        approved = undefined;

        return {
          status: 200,
          body: {authorization_code: grant.code, code_verifier: grant.verifier},
        };
      }
      case '/oauth/token':
        if (
          fields['grant_type'] === 'authorization_code' &&
          grant !== undefined &&
          fields['code'] === grant.code
        ) {
          const {account} = grant;

          grant = undefined;

          return {status: 200, body: tokens(account, true)};
        }

        if (
          fields['grant_type'] === 'refresh_token' &&
          refreshToken !== undefined &&
          fields['refresh_token'] === refreshToken.token
        ) {
          return {status: 200, body: tokens(refreshToken.account, false)};
        }

        return {status: 401, body: {error: {message: 'refresh_token_reused'}}};
      default:
        return {status: 404, body: {}};
    }
  };
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const body = await text(request);
    // The daemon sends a form or a JSON object, nothing else.
    const fields =
      request.headers['content-type'] === 'application/x-www-form-urlencoded'
        ? Object.fromEntries(new URLSearchParams(body))
        : (JSON.parse(body) as Readonly<Record<string, unknown>>);
    const path = request.url ?? '';

    requests.push({path, fields});

    const {status, body: answered} = answer(path, fields);

    response
      .writeHead(status, {'content-type': 'application/json'})
      .end(JSON.stringify(answered));
  };
  const server = createServer((request, response) => {
    // A request that broke off has nobody left to answer.
    respond(request, response).catch(() => {
      request.socket.destroy();
    });
  });
  const port = await servedOnLoopback(server);
  const base = `http://127.0.0.1:${String(port)}`;

  attachEvidence(
    () =>
      `OpenAI's sign-in: ${requests.map(request => request.path).join(', ')}`,
  );

  return {
    env: {PROJECT02_TEST_OPENAI_AUTH: base},
    page: `${base}/codex/device`,
    callback: `${base}/deviceauth/callback`,
    requests,
    code: () => {
      const newest = codes.at(-1);

      return newest === undefined
        ? undefined
        : {userCode: newest.userCode, expiresAt: newest.expiresAt};
    },
    approve: (account = sam) => {
      const newest = codes.at(-1);

      if (newest !== undefined) {
        approved = {deviceAuthId: newest.deviceAuthId, account};
      }
    },
    secrets: () => secrets,
  };
}
