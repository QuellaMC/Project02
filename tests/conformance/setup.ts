/** Vitest's end of a test, for the harness: the setup file of the conformance project and of the differential run. */
import {onTestFinished} from 'vitest';

import {useRunner} from './harness/runner.ts';

useRunner({onTestFinished});
