import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDefaultCharacterRuntimeState,
  createFileCharacterStateStore,
  createLivingStateBrief,
  createLocalRuntimeSessionPaths,
  createLocalRuntimeSessionStore,
  LocalRuntimeStorageContractError,
  planCharacterStatePatch
} from '../src/index.ts';

const tempStoreRoots: string[] = [];

describe('character state', () => {
  afterEach(() => {
    for (const storeRoot of tempStoreRoots.splice(0)) {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });

  it('creates a compact immutable living-state brief from the default state', () => {
    const state = createDefaultCharacterRuntimeState();
    const brief = createLivingStateBrief(state);

    expect(state).toEqual({
      version: 'mvp-006.character_state.v1',
      current: {
        mood: 'steady',
        energy: 'medium',
        attention: 'present',
        currentActivity: 'idle',
        socialOrientation: 'open'
      }
    });
    expect(brief.text).toBe(
      'mood=steady; energy=medium; attention=present; activity=idle; social=open'
    );
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.current)).toBe(true);
    expect(Object.isFrozen(brief.current)).toBe(true);
  });

  it('accepts changing and no-op patches with explicit applied change evidence', () => {
    const before = createDefaultCharacterRuntimeState();
    const changed = planCharacterStatePatch({
      before,
      patchInput: {
        mood: 'curious',
        currentActivity: 'chatting'
      }
    });
    const noop = planCharacterStatePatch({
      before,
      patchInput: {
        mood: 'steady'
      }
    });

    expect(changed).toMatchObject({
      status: 'accepted',
      patch: {
        mood: 'curious',
        currentActivity: 'chatting'
      },
      after: {
        current: {
          mood: 'curious',
          currentActivity: 'chatting'
        }
      },
      appliedChanges: [
        {
          field: 'mood',
          before: 'steady',
          after: 'curious'
        },
        {
          field: 'currentActivity',
          before: 'idle',
          after: 'chatting'
        }
      ]
    });
    expect(noop).toMatchObject({
      status: 'accepted',
      appliedChanges: []
    });
  });

  it('rejects unsupported fields and invalid enum values without changing state', () => {
    const before = createDefaultCharacterRuntimeState();

    expect(
      planCharacterStatePatch({
        before,
        patchInput: {
          memory: 'invented'
        }
      })
    ).toMatchObject({
      status: 'rejected',
      before,
      rejection: {
        reason: 'unsupported_state_field'
      }
    });
    expect(
      planCharacterStatePatch({
        before,
        patchInput: {
          mood: 'ecstatic'
        }
      })
    ).toMatchObject({
      status: 'rejected',
      before,
      rejection: {
        reason: 'invalid_state_value'
      }
    });
  });

  it('persists current state under the existing local session path and fails closed on malformed state', async () => {
    const storeRoot = createTempStoreRoot();
    const sessionStore = createLocalRuntimeSessionStore({ storeRoot });

    await sessionStore.createSession({ sessionId: 'mira-local' });

    const store = createFileCharacterStateStore({
      storeRoot,
      sessionId: 'mira-local'
    });
    const before = store.readCurrentState();
    const plan = planCharacterStatePatch({
      before,
      patchInput: {
        energy: 'high'
      }
    });

    expect(plan.status).toBe('accepted');

    if (plan.status !== 'accepted') {
      throw new Error('Expected accepted character state patch.');
    }

    store.writeCurrentState(plan.after);

    expect(
      createFileCharacterStateStore({
        storeRoot,
        sessionId: 'mira-local'
      }).readCurrentState().current.energy
    ).toBe('high');

    const paths = createLocalRuntimeSessionPaths({
      storeRoot,
      sessionId: 'mira-local'
    });

    writeFileSync(paths.characterStatePath, '{"version":"broken"}\n', 'utf8');

    expect(() => store.readCurrentState()).toThrow(
      LocalRuntimeStorageContractError
    );
  });
});

function createTempStoreRoot(): string {
  const storeRoot = mkdtempSync(join(tmpdir(), 'project02-character-state-'));

  mkdirSync(storeRoot, { recursive: true });
  tempStoreRoots.push(storeRoot);

  return storeRoot;
}
