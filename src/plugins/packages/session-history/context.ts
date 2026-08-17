import {sessionHistoryPluginId} from '../../api/contract.ts';
import {createRuntimePluginContextItem} from '../../api/index.ts';
import {createPluginContextEvidence} from '../../api/evidence-helpers.ts';
import type {RuntimePluginLifecycleHooks} from '../../api/types.ts';
import {estimateTextTokens} from '../../../shared/token-estimate.ts';

const sessionHistoryGuidanceText =
  'When they bring up an earlier conversation, or the answer may sit ' +
  'further back than you can see (including earlier in this one), look it ' +
  'up with sessions.search before asking them to repeat themselves; read ' +
  'more of a past conversation with sessions.read.';

// A trusted runtime note is cap-checked, not budgeted; the priority only
// orders it among an operator plugin's untrusted items if it ever lands there.
const sessionHistoryGuidancePriority = 20;

export function createSessionHistoryGuidanceHook(): NonNullable<
  RuntimePluginLifecycleHooks['beforeRoleModelCall']
> {
  return context => ({
    contextItems: [
      createRuntimePluginContextItem({
        pluginId: sessionHistoryPluginId,
        id: 'session-history.guidance',
        kind: 'runtime_note',
        text: sessionHistoryGuidanceText,
        budget: {
          estimatedTokens: estimateTextTokens(sessionHistoryGuidanceText),
          priority: sessionHistoryGuidancePriority,
        },
        sourceReferences: [],
        redactionLabels: [],
      }),
    ],
    evidence: [
      createPluginContextEvidence({
        context,
        pluginId: sessionHistoryPluginId,
        status: 'accepted',
        summary: 'Provided session-history recall guidance.',
      }),
    ],
  });
}
