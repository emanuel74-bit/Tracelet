import { startStaticHost } from '../../scripts/serve-test.mjs';
export default async function setup() {
  const server = await startStaticHost();
  return async () => {
    server.closeAllConnections();
    await new Promise((done, fail) => server.close(error => error ? fail(error) : done()));
  };
}
