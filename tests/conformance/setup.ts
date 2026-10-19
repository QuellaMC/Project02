/** Vitest's end of a test, for the harness: the conformance project's setup file. */
import {onTestFinished} from 'vitest';

import {useRunner} from './harness/runner.ts';

useRunner({onTestFinished});
