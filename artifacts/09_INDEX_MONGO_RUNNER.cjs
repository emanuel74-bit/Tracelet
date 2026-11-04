const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// Reuse already installed test tooling read-only; no manifest or lock changes.
const { MongoMemoryServer } = require(path.join(root, '.review08/node_modules/mongodb-memory-server'));
const temp = path.join(root, '.index-mongo-temp');
fs.mkdirSync(temp, { recursive: true });
process.env.TEMP = temp; process.env.TMP = temp;
async function main() {
  const server = await MongoMemoryServer.create({ binary: { systemBinary: path.join(root, '.review08/node_modules/.cache/mongodb-memory-server/mongod-x64-win32-8.2.6.exe') }, auth: { enable: true, customRootName: 'indexroot', customRootPwd: 'index-test-root-password' } });
  try {
    const uri = new URL(server.getUri());
    uri.username = 'indexroot'; uri.password = 'index-test-root-password'; uri.searchParams.set('authSource', 'admin');
    const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', 'packages/tracelet', '--config', path.join(root, 'artifacts/09_INDEX_MONGO.config.mts')], {
      cwd: root, stdio: 'inherit', env: { ...process.env, TRACELET_INDEX_TEST_MONGO_URI: uri.toString(), TRACELET_TEST_MONGO_URI: uri.toString() },
    });
    process.exitCode = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code ?? 1)); });
  } finally { await server.stop(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
