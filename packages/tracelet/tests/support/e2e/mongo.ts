export interface DisposableMongo {
  uri: string;
  source: 'TRACELET_E2E_MONGO_URI' | 'mongodb-memory-server';
  /** Only the in-process memory server can be stopped mid-test. */
  stop(): Promise<void>;
  canStop: boolean;
}

export const NOT_RUN = 'NOT RUN: no disposable MongoDB (set TRACELET_E2E_MONGO=memory to use mongodb-memory-server, or TRACELET_E2E_MONGO_URI to a throwaway mongod; see README "Running the real-Mongo suites")';

/**
 * Opt-in only. Never connects to anything unless asked:
 *  - TRACELET_E2E_MONGO_URI: a user-supplied THROWAWAY mongod (tests create and drop uniquely named databases);
 *  - TRACELET_E2E_MONGO=memory: a mongod started by mongodb-memory-server on a random loopback port.
 * Returns undefined (tests then skip with NOT_RUN) when neither is set or the server cannot be started.
 */
export async function acquireMongo(): Promise<DisposableMongo | undefined> {
  const uri = process.env.TRACELET_E2E_MONGO_URI;
  if (uri) return { uri, source: 'TRACELET_E2E_MONGO_URI', canStop: false, stop: async () => undefined };
  if (process.env.TRACELET_E2E_MONGO !== 'memory') return undefined;
  try {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
    return { uri: server.getUri(), source: 'mongodb-memory-server', canStop: true, stop: async () => void (await server.stop()) };
  } catch (e) {
    console.warn(`[e2e] mongodb-memory-server could not start (${(e as Error).message.slice(0, 200)}); real-Mongo e2e tests will be skipped`);
    return undefined;
  }
}
