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
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error'
    }
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      complexity: ['error', 20],
      'max-lines': [
        'error',
        { max: 400, skipBlankLines: true, skipComments: true }
      ],
      'max-lines-per-function': [
        'error',
        { max: 200, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  // File-size ratchet: each file below is pinned at its current size and may only shrink.
  // Delete a file's override once it drops under the global 400-line cap.
  {
    files: ['src/plugins/host/host.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 1750, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/cli/chat/main.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 1079, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/cli/config/console.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 766, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/cli/config/main.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 608, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/evidence/turn-projection.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 869, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/plugins/builtin/plugin-management/config-update.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 524, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/plugins/api/constructors.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 878, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/storage/plugin-file-store/durable-primitives.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 582, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/storage/plugin-file-store/transaction.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 548, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/storage/plugin-file-store/wal.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 1603, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/plugins/api/manifest-validation.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 726, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/plugins/builtin/memory-provider/provider-lifecycle.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 452, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/plugins/package-loader/index.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 671, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/plugins/packages/character-state/plugin.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 576, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/plugins/packages/character-state/schema.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 509, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/plugins/api/tool-schema-validation.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 453, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/role-model/loop/decision-parser.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 695, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/role-model/api/provider-exchange.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 467, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/role-model/loop/loop.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 1721, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/role-model/api/model-tools.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 628, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/role-model/prompt/render.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 684, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/role-model/providers/nvidia.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 1230, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/app/activation.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 1113, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/config/load.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 599, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/config/mutate.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 1207, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/config/resolve.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 588, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/storage/mutation-lock.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 941, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/storage/raw-event-codec.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 1671, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/evidence/validation.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 2072, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/storage/session-store.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 981, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/turn/commit.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 720, skipBlankLines: true, skipComments: true }
      ]
    }
  },
  {
    files: ['src/runtime/turn/model.ts'],
    rules: {
      'max-lines': [
        'error',
        { max: 560, skipBlankLines: true, skipComments: true }
      ]
    }
  }
);
