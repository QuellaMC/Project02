import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 4,
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 85.3,
        branches: 79.1,
        functions: 94.4,
        lines: 85.3,
        'src/runtime/turn/input.ts': {
          statements: 31,
          branches: 31,
          functions: 57,
          lines: 31
        },
        'src/runtime/storage/atomic-file.ts': {
          statements: 88,
          branches: 68,
          functions: 88,
          lines: 88
        },
        'src/runtime/storage/mutation-lock.ts': {
          statements: 80,
          branches: 70,
          functions: 92,
          lines: 80
        },
        'src/runtime/storage/codec-primitives.ts': {
          statements: 70,
          branches: 55,
          functions: 95,
          lines: 70
        },
        'src/runtime/storage/conversation-codec.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95
        },
        'src/runtime/storage/raw-event-codec.ts': {
          statements: 75,
          branches: 70,
          functions: 95,
          lines: 75
        },
        'src/runtime/storage/raw-event-tool-semantics.ts': {
          statements: 80,
          branches: 82,
          functions: 95,
          lines: 80
        },
        'src/runtime/storage/trace-codec.ts': {
          statements: 95,
          branches: 95,
          functions: 95,
          lines: 95
        },
        'src/runtime/storage/runtime-evidence-validation.ts': {
          statements: 83,
          branches: 76,
          functions: 90,
          lines: 83
        },
        'src/runtime/storage/runtime-evidence-recovery.ts': {
          statements: 82,
          branches: 74,
          functions: 90,
          lines: 82
        },
        'src/runtime/storage/file-runtime-log-store.ts': {
          statements: 88,
          branches: 95,
          functions: 95,
          lines: 88
        },
        'src/runtime/storage/file-runtime-log-store-state.ts': {
          statements: 90,
          branches: 88,
          functions: 90,
          lines: 90
        },
        'src/runtime/storage/session-store.ts': {
          statements: 78,
          branches: 65,
          functions: 95,
          lines: 78
        },
        'src/runtime/storage/runtime-evidence-cache.ts': {
          statements: 78,
          branches: 65,
          functions: 95,
          lines: 78
        },
        'src/plugins/file-store/wal-codec.ts': {
          statements: 80,
          branches: 78,
          functions: 88,
          lines: 80
        },
        'src/plugins/file-store/wal-progress.ts': {
          statements: 65,
          branches: 60,
          functions: 80,
          lines: 65
        },
        'src/plugins/file-store/wal.ts': {
          statements: 82,
          branches: 74,
          functions: 85,
          lines: 82
        }
      }
    }
  }
});
