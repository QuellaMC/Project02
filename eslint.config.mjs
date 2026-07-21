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
    // Grown across the live config-reload seam and its review hardening
    // (reload policy in src/plugins/host/reload.ts; the retired-instance
    // registry in src/plugins/host/instance-lifecycle.ts), then ratcheted
    // back DOWN from its 1961 peak as the late-dispatch machinery was
    // deleted in favor of the plain ordered-phase model. Remaining bulk:
    // state refs, reload/currency delegation, and the confirmed
    // config-update turn log.
    files: ['src/plugins/host/host.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1895, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/cli/chat/main.ts'],
    rules: {
      // Re-pinned +33 for character activation wiring (startup character
      // resolution, profile threading, required-profile guard), +2 for
      // selecting the configured character id from resolved config, then
      // +13 for the configurable user display name (per-session prompt
      // label, threading into the durable runtime and fallback session).
      'max-lines': [
        'error',
        {max: 1127, skipBlankLines: true, skipComments: true},
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
    // Re-pinned +2 to inject the plugin reloader capability into the host,
    // then +13 to stamp the plan with its authored-config fingerprint and
    // hand it to the host as the construction-currency signal recovery uses.
    files: ['src/app/activation.ts'],
    rules: {
      'max-lines': [
        'error',
        {max: 1147, skipBlankLines: true, skipComments: true},
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
      // Re-pinned +1 for the shared localUserSpeaker import (mechanical
      // growth; replaces inline 'local-user'/'You' literals), +19 for
      // bound-character injection (expected-character chain guard,
      // unanchored-guard parameterization, character-less placeholder),
      // then +45 for the session user speaker: recorded/bound user-speaker
      // state, the one-user-speaker-per-session derivation, and restored
      // transcripts validating against the recorded user display name.
      'max-lines': [
        'error',
        {max: 2184, skipBlankLines: true, skipComments: true},
      ],
    },
  },
  {
    files: ['src/runtime/storage/session-store.ts'],
    rules: {
      // Re-pinned +3 for the evidence-required rehydration error (the
      // session character is evidence-derived and has no default), +2 for
      // allowlisting the character binding and packages entries in the
      // store-initialization content check, then +5 for threading the
      // evidence-derived user speaker through rehydration.
      'max-lines': [
        'error',
        {max: 1014, skipBlankLines: true, skipComments: true},
      ],
    },
  },
);
