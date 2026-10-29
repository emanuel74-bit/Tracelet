// Adapted from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec). Changes: see third_party/nestjs-observe/FORK_DELTA.instrumentation.md
import { randomBytes } from 'node:crypto';

/**
 * A UUID whose first 48 bits are the minting time, milliseconds since the epoch (RFC 9562 version 7).
 */
export function uuidv7(now: number = Date.now()): string {
  // Ten random bytes: 12 bits go into `rand_a`, 62 into `rand_b`. The two version and two variant bits overwrite what they need.
  const rand = randomBytes(10);

  const bytes = Buffer.allocUnsafe(16);
  // 48-bit big-endian timestamp, placed as a 32/16 split so no shift runs past 2^32.
  bytes.writeUInt32BE(Math.floor(now / 0x10000), 0);
  bytes.writeUInt16BE(now % 0x10000, 4);
  // Version 7 in the top nibble, 12 random bits below it.
  bytes[6] = 0x70 | (rand[0] & 0x0f);
  bytes[7] = rand[1];
  // Variant `10` in the top two bits, 62 random bits below.
  bytes[8] = 0x80 | (rand[2] & 0x3f);
  rand.copy(bytes, 9, 3, 10);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
