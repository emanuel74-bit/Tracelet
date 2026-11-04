// Storage-only execution avoids unrelated instrumentation transformers.
export default { test: { include: ['tests/integration/storage/index-failures.int-spec.ts', 'tests/integration/storage/mongo.int-spec.ts'], environment: 'node', fileParallelism: false, testTimeout: 30000 } };
