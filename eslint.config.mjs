import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'vitest.config.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {prefer: 'type-imports', fixStyle: 'inline-type-imports'},
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      // Google TS style (gts) core rules not covered by the presets above.
      'block-scoped-var': 'error',
      eqeqeq: 'error',
      'no-var': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {object: 'describe', property: 'only'},
        {object: 'it', property: 'only'},
        {object: 'test', property: 'only'},
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      complexity: ['error', 20],
      'max-lines': [
        'error',
        {max: 1000, skipBlankLines: true, skipComments: true},
      ],
      'max-lines-per-function': [
        'error',
        {max: 200, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  // File-size ratchet: each file below is pinned at its current size and may only shrink.
  // Delete a file's override once it drops under the global 1000-line cap.
  // The cap is a runaway guard, not an organizing principle: pins come down through
  // seam-based extraction only (never size-motivated cuts), and a cohesive file that
  // genuinely needs to grow may raise its pin in its own commit with a stated reason.
  {
    // Re-pinned +2 for the inventory/control host-state import split, then
    // +46 for the live config-reload seam (state refs, superseded-instance
    // retention, and method delegation only; the reload policy lives in
    // src/plugins/host/reload.ts).
    files: ['src/plugins/host/host.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1826, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/cli/chat/main.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1079, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/runtime/storage/plugin-file-store/wal.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1603, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/role-model/loop/loop.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1485, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/role-model/providers/nvidia.ts'],
    rules: {
      'max-lines': [
        'error',
        // Re-pinned +2 for the tool-wire import split (mechanical growth).
        {max: 1159, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    // Re-pinned +2 to inject the plugin reloader capability into the host.
    files: ['src/app/activation.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1134, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/runtime/config/mutate.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1216, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/runtime/storage/raw-event-codec.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1672, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/runtime/evidence/validation.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 2119, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/runtime/storage/session-store.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1004, skipBlankLines: true, skipComments: true},
      ],
    },
  },
);
