import { hostname as osHostname } from 'node:os';
import type { InstanceIdentity } from '../contracts';
import { getGlobalSlot } from './als';
import { uuidv7 } from './uuid-v7';

/** Minted once per process (kept in the global slot, so duplicate package copies agree). */
export function getBootId(): string {
  const slot = getGlobalSlot();
  if (slot.bootId === undefined) slot.bootId = uuidv7();
  return slot.bootId;
}

export const BOOT_ID: string = getBootId();
const STARTED_AT = new Date().toISOString();

export function createInstanceIdentity(opts: {
  serviceName: string;
  serviceVersion?: string;
  hostName?: string;
}): InstanceIdentity {
  const hostName = opts.hostName ?? osHostname();
  const sanitized = hostName.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 115);
  const identity: InstanceIdentity = {
    serviceName: opts.serviceName,
    hostName,
    pid: process.pid,
    bootId: BOOT_ID,
    instanceId: `${sanitized}-${BOOT_ID.replace(/-/g, '').slice(-12)}`,
    startedAt: STARTED_AT,
  };
  if (opts.serviceVersion !== undefined) identity.serviceVersion = opts.serviceVersion;
  return identity;
}
