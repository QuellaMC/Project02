import {isNodeErrorWithCode} from '../../shared/node-error.ts';

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, 'ESRCH')) {
      return false;
    }

    if (isNodeErrorWithCode(error, 'EPERM')) {
      return true;
    }

    throw error;
  }
}
