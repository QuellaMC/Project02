/**
 * The home's sign-in to a ChatGPT plan as the page shows it: what the
 * plan's page and the welcome draw in each state health says it stands
 * in, and who it is signed in as, in a person's words. Nothing here
 * touches the DOM.
 */
import type {ChatgptSignIn, PlanAccount} from '@project02/wire/contract';

/** One part of who the plan is signed in as: what it is, and its value. */
export type AccountRow = {readonly label: string; readonly value: string};

/** What the plan's sign-in draws, by how health says it stands. */
export type PlanShown =
  /** Sign In, with the daemon's sentence when the last sign-in failed or ended. */
  | {readonly step: 'sign-in'; readonly problem?: string}
  /** The code the person approves on OpenAI's page, at `url`, while the daemon waits. */
  | {readonly step: 'code'; readonly code: string; readonly url: string}
  /** Who it is signed in as, and Sign Out. */
  | {readonly step: 'signed-in'; readonly rows: readonly AccountRow[]};

export function planShown(signIn: ChatgptSignIn): PlanShown {
  switch (signIn.state) {
    case 'signed_out':
      return {
        step: 'sign-in',
        ...(signIn.message === undefined ? {} : {problem: signIn.message}),
      };
    case 'waiting':
      return {step: 'code', code: signIn.code, url: signIn.url};
    case 'signed_in':
      return {step: 'signed-in', rows: accountRows(signIn)};
  }
}

/** What the plan's row on AI Model says once it is signed in: `sam@example.com · Plus`. */
export function accountLine(account: PlanAccount): string {
  return accountRows(account)
    .map(row => row.value)
    .join(' · ');
}

/** Each part of the account OpenAI named that is known: its email, and its plan, `plus` said as Plus. */
function accountRows(account: PlanAccount): readonly AccountRow[] {
  const {email, plan} = account;

  return [
    ...(email === undefined ? [] : [{label: 'Account', value: email}]),
    ...(plan === undefined
      ? []
      : [
          {
            label: 'Plan',
            value: `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`,
          },
        ]),
  ];
}
