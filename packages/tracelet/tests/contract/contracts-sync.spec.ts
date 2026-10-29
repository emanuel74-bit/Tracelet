import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Plan 3.3: the copies in src/contracts must stay byte-identical to the kit's frozen files. Vitest runs from packages/tracelet.
const KIT = resolve(process.cwd(), '../../docs/embedded-observe-kit/resources/contracts');
const COPY = resolve(process.cwd(), 'src/contracts');
// Line endings are normalised to LF: with core.autocrlf a Windows checkout turns the git blob (whose SHA-256 the freeze doc
// records) into CRLF. Byte-identity is therefore asserted on the LF form, which is what git stores.
const sha = (path: string) => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex');

describe('contracts-sync', () => {
  for (const file of ['observe-contracts.ts', 'tracelet-internal-contracts.ts', 'telemetry.schema.json']) {
    it(`${file} is byte-identical to the kit file`, () => {
      expect(sha(resolve(COPY, file))).toBe(sha(resolve(KIT, file)));
    });
  }

  it('matches the SHA-256 recorded in artifacts/01_CONTRACT_FREEZE.md', () => {
    expect(sha(resolve(COPY, 'observe-contracts.ts'))).toBe('8c3722d7d9a29654442b6542020589f873dab3cbfc679e896878763aa9320cc9');
    expect(sha(resolve(COPY, 'tracelet-internal-contracts.ts'))).toBe('9a8574c7251c370bb9bbb412c8b40fcd38538faa62890bc46c84c8253227e05f');
    expect(sha(resolve(COPY, 'telemetry.schema.json'))).toBe('82fc0f3e7021addbf4941ede3549c702e701b2fc3223893407cfca98801fe905');
  });
});
