import {describe, expect, it} from 'vitest';

import {planShown} from './chatgpt-plan.ts';

describe('chatgpt plan', () => {
  it("shows Sign In while the home is signed out, with the daemon's sentence once a sign-in failed or ended; while a code waits, the code and where to type it; and signed in, the account and its plan in a person's words, each part OpenAI named", () => {
    const expired = 'The code expired before it was approved. Start again.';

    expect(planShown({state: 'signed_out'})).toEqual({step: 'sign-in'});
    expect(planShown({state: 'signed_out', message: expired})).toEqual({
      step: 'sign-in',
      problem: expired,
    });
    expect(
      planShown({
        state: 'waiting',
        code: 'QK7M-2XPD',
        url: 'https://auth.openai.com/codex/device',
        expiresAt: 1_793_000_000_000,
      }),
    ).toEqual({
      step: 'code',
      code: 'QK7M-2XPD',
      url: 'https://auth.openai.com/codex/device',
    });
    expect(
      planShown({state: 'signed_in', email: 'sam@example.com', plan: 'plus'}),
    ).toEqual({
      step: 'signed-in',
      rows: [
        {label: 'Account', value: 'sam@example.com'},
        {label: 'Plan', value: 'Plus'},
      ],
    });
    expect(planShown({state: 'signed_in', plan: 'pro'})).toEqual({
      step: 'signed-in',
      rows: [{label: 'Plan', value: 'Pro'}],
    });
  });
});
