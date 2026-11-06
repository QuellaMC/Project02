import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Generated from the Rust wire types; neither written nor styled by hand.
  {ignores: ['packages/wire/src/contract/generated/']},
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['packages/**/*.ts', 'packages/**/*.tsx', 'tests/**/*.ts'],
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
      // Playwright fixtures take their dependencies as a destructured
      // parameter; one that needs none is spelled `{}`.
      'no-empty-pattern': ['error', {allowObjectPatternsAsParameters: true}],
      'no-var': 'error',
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['packages/**/*.test.ts', 'tests/**/*.ts'],
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
    files: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
    ignores: ['**/*.test.ts'],
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
);
