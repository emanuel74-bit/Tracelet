// Import-boundary rules implement plan section 5 (module dependency graph).
import tseslint from 'typescript-eslint';

/** Directories under src/ that a given directory must not import from (relative path patterns). */
const FORBIDDEN = {
  contracts: ['shared', 'context', 'instrumentation', 'buffer', 'profiling', 'storage', 'query', 'api', 'http', 'config'],
  shared: ['context', 'instrumentation', 'buffer', 'profiling', 'storage', 'query', 'api', 'http', 'config'],
  context: ['instrumentation', 'buffer', 'profiling', 'storage', 'query', 'api', 'http', 'config'],
  instrumentation: ['buffer', 'profiling', 'storage', 'query', 'api', 'http', 'config'],
  buffer: ['instrumentation', 'profiling', 'storage', 'query', 'api', 'http', 'config'],
  profiling: ['context', 'instrumentation', 'buffer', 'storage', 'query', 'api', 'http', 'config'],
  storage: ['context', 'instrumentation', 'buffer', 'profiling', 'query', 'api', 'http', 'config'],
  query: ['context', 'instrumentation', 'buffer', 'profiling', 'api', 'http', 'config'],
  api: ['context', 'instrumentation', 'buffer', 'profiling', 'storage', 'http', 'config'],
  http: ['context', 'instrumentation', 'buffer', 'profiling', 'storage', 'query', 'config'],
  config: ['shared', 'context', 'instrumentation', 'buffer', 'profiling', 'storage', 'query', 'api', 'http'],
};

const boundaryConfigs = Object.entries(FORBIDDEN).map(([dir, forbidden]) => ({
  files: [`src/${dir}/**/*.ts`],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: forbidden.flatMap((f) => [`**/${f}`, `**/${f}/**`]),
            message: `src/${dir} must not import from this module (plan section 5 dependency graph).`,
          },
        ],
      },
    ],
  },
}));

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'ui/**', 'assets/**', 'src/contracts/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  ...boundaryConfigs,
);
