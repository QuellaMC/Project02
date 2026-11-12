/**
 * The home's sign-in to a ChatGPT plan, one block for the plan's page and
 * the welcome: Sign In, then the code to approve on OpenAI's page with
 * Copy Code, Open OpenAI and Cancel, the warning under both, then who it
 * is signed in as and Sign Out. Health says which, so it moves on by
 * itself.
 */
import {useState} from 'react';

import type {ChatgptSignIn} from '@project02/wire/contract';
import {planShown} from './chatgpt-plan.ts';
import type {Session} from './session.ts';
import {Cell, Group, Icon, Label} from './settings-controls.tsx';

export function PlanSignIn({
  signIn,
  session,
}: {
  readonly signIn: ChatgptSignIn | undefined;
  readonly session: Session;
}) {
  if (signIn === undefined) {
    return null;
  }

  const shown = planShown(signIn);

  switch (shown.step) {
    case 'sign-in':
      return (
        <>
          <Group>
            <Cell
              kind="field"
              problems={shown.problem === undefined ? [] : [shown.problem]}
            >
              <Label
                name="Sign in with your ChatGPT account"
                detail="You approve a short code on OpenAI's own page."
              />
              <button
                type="button"
                className="button-pill button-filled"
                onClick={() => {
                  void session.startChatgptSignIn();
                }}
              >
                Sign In
              </button>
            </Cell>
          </Group>
          <PlanWarning />
        </>
      );
    case 'code':
      return (
        <>
          <Group footer="The code works for 15 minutes. This page moves on by itself once you approve it.">
            <PlanCode key={shown.code} code={shown.code} url={shown.url} />
          </Group>
          <div className="actions">
            <button
              type="button"
              className="button-pill"
              onClick={() => {
                void session.cancelChatgptSignIn();
              }}
            >
              Cancel
            </button>
          </div>
          <PlanWarning />
        </>
      );
    case 'signed-in':
      return (
        <>
          <Group footer="Replies use your plan's limits. When they run out, a character cannot answer until they reset, and says so.">
            {shown.rows.map(row => (
              <Cell key={row.label}>
                <Label name={row.label} />
                <span className="value">{row.value}</span>
              </Cell>
            ))}
          </Group>
          <button
            type="button"
            className="button-danger"
            onClick={() => {
              void session.signOutOfChatgpt();
            }}
          >
            Sign Out
          </button>
        </>
      );
  }
}

/**
 * The code, large, to copy or to type on OpenAI's page, which opens in
 * the person's browser; Copied once it is on the clipboard.
 */
function PlanCode({code, url}: {readonly code: string; readonly url: string}) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      // A browser that copies nothing leaves the code to be read off the page.
    }
  };

  return (
    <div className="plan-code">
      <span className="plan-code-title">Your Code</span>
      <span className="plan-code-text">{code}</span>
      <div className="plan-code-buttons">
        <button
          type="button"
          className="button-pill"
          onClick={() => {
            void copy();
          }}
        >
          {copied ? 'Copied' : 'Copy Code'}
        </button>
        <a
          className="button-pill button-filled"
          href={url}
          target="_blank"
          rel="noreferrer"
        >
          Open OpenAI
        </a>
      </div>
      <span className="plan-waiting">
        Waiting for you to enter the code there…
      </span>
    </div>
  );
}

/** Said wherever the person signs in, until they are: this is no official way to use a plan. */
function PlanWarning() {
  return (
    <p className="plan-warning">
      <Icon name="alert" size={20} weight={1.8} />
      <span>
        <strong>
          This is not an official way to use a plan in another app.
        </strong>{' '}
        It signs in the way OpenAI&apos;s own Codex app does. OpenAI can change
        or block it, and could restrict an account that uses it. An API key is
        the dependable way.
      </span>
    </p>
  );
}
