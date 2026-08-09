import {sessionHistoryPluginId} from '../../api/contract.ts';
import {createRuntimePluginContextItem} from '../../api/index.ts';
import {createPluginContextEvidence} from '../../api/evidence-helpers.ts';
import type {RuntimePluginLifecycleHooks} from '../../api/types.ts';

const sessionHistoryGuidanceText =
  'When the user references a past conversation, or relevant context may ' +
  'exist beyond what you can see (including earlier in this conversation), ' +
  'use sessions.search to recall it before asking them to repeat ' +
  'themselves; scroll the transcript with sessions.read.';

// Below memory recall (priority 70): the nudge is the first thing to evict
// when real recalled context needs the prompt budget.
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
          estimatedTokens: Math.ceil(sessionHistoryGuidanceText.length / 4),
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
