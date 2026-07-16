import { afterEach, describe, expect, it, vi } from 'vitest';

import { processIsAlive } from '../src/runtime/storage/process-liveness.ts';

describe('process liveness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats a missing process as dead', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
    });

    expect(processIsAlive(123)).toBe(false);
  });

  it('treats a permission failure as evidence that the process exists', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    });

    expect(processIsAlive(123)).toBe(true);
  });

  it('does not hide unexpected process probe failures', () => {
    const error = Object.assign(new Error('unexpected probe failure'), {
      code: 'EINVAL'
    });
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error;
    });

    expect(() => processIsAlive(123)).toThrow(error);
  });
});
