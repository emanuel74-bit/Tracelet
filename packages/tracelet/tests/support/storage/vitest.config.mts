// Storage tests use no decorators; avoid the instrumentation-only native SWC transformer.
export default { test: { include: ['tests/unit/storage/**/*.spec.ts'], environment: 'node' } };
