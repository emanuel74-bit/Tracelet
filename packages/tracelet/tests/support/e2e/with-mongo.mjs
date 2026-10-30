// Runs the opt-in real-Mongo suites against a disposable mongod started by mongodb-memory-server:
//   npm run -w tracelet test:mongo
// Starts one mongod on a random loopback port, exports its URI as TRACELET_E2E_MONGO_URI (e2e) and TRACELET_TEST_MONGO_URI
// (storage integration test), runs the e2e and storage suites, then stops the server. Nothing outside the repo is touched
// except the mongod binary cache of mongodb-memory-server.
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';

const server = await MongoMemoryServer.create({ instance: { ip: '127.0.0.1' } });
const uri = server.getUri();
const env = { ...process.env, TRACELET_E2E_MONGO_URI: uri, TRACELET_TEST_MONGO_URI: uri };
let status = 0;
try {
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  for (const args of [
    ['vitest', 'run', '--config', 'vitest.int.config.mts', 'tests/integration/storage'],
    ['vitest', 'run', '--config', 'vitest.e2e.config.mts'],
  ]) {
    // ASYNC spawn: mongod runs inside THIS process (mongodb-memory-server), so blocking the event loop here would stall it.
    const code = await new Promise(resolve => {
      const child = spawn(npx, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
      child.on('error', () => resolve(1));
      child.on('exit', c => resolve(c ?? 1));
    });
    if (code !== 0) status = code;
  }
} finally {
  await server.stop();
}
process.exit(status);
