import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import inspector from 'node:inspector';
import net from 'node:net';
import tls from 'node:tls';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedTelemetryQueue } from '../../../src/buffer/index.js';
import type { MetricItem, ProfileItem, TelemetryItem } from '../../../src/contracts/index.js';
import schema from '../../../src/contracts/telemetry.schema.json';
import { ContinuousProfiler, MetricsCollector } from '../../../src/profiling/index.js';
import { TimerLeakTracker } from '../../support/profiling/leak-tracker.js';
import { sleep } from '../../support/profiling/load.js';
import { skipIfBusyWait } from '../../support/profiling/runtime-gate.js';

/* M06 (plan 17, T09/T10/T18 additions) against the REAL inspector: restart, shutdown, disabled, bounded pool, no network, and
 * the inspector-integration cases (a host's own Session, a host console.profile). */

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema as object);
const sid = (schema as { $id: string }).$id;
const validProfile = ajv.getSchema(sid + '#/$defs/CpuProfile')!;
const validMetric = ajv.getSchema(sid + '#/$defs/MetricRollup')!;

const profilesOf = (items: TelemetryItem[]): ProfileItem[] => items.filter((i): i is ProfileItem => i.type === 'profile');

function busy(ms: number): void {
  const end = performance.now() + ms;
  let x = 1;
  while (performance.now() < end) x = (x * 31 + 7) % 1000003;
  if (x === -1) throw new Error('unreachable');
}

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  expect(cond(), 'condition not reached in time').toBe(true);
}

const live: Array<{ stop: () => unknown }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const x of live.splice(0)) await x.stop();
});

function profilerOn(queue: BoundedTelemetryQueue, windowMs: number, extra: Record<string, unknown> = {}) {
  const p = new ContinuousProfiler({ enabled: true, windowMs, ...extra }, { queue, serviceName: 'm06', instanceId: 'm06-1' });
  live.push(p);
  return p;
}

describe('restart: stop/start repeatedly on the real inspector', () => {
  it('10 cycles: every session connected is disconnected, no timer survives, state returns to running/stopped, profiles stay valid', async (ctx) => {
    skipIfBusyWait(ctx);
    const connect = vi.spyOn(inspector.Session.prototype, 'connect');
    const disconnect = vi.spyOn(inspector.Session.prototype, 'disconnect');
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 1000 });
      const p = profilerOn(queue, 40);
      for (let i = 0; i < 10; i++) {
        await p.start();
        expect(p.profilerHealth().state).toBe('running');
        await p.start(); // idempotent while running
        busy(30);
        await sleep(60); // at least one rotation
        await p.stop();
        expect(p.profilerHealth().state).toBe('stopped');
        await p.stop(); // idempotent
      }
      // each start() = one throwaway probe session + one sampler session; every connect has its disconnect
      expect(connect.mock.calls.length).toBe(20);
      expect(disconnect.mock.calls.length).toBe(20);
      await sleep(80);
      expect(await tracker.leakedSince(before)).toEqual([]);
      const items = profilesOf(queue.drain(10_000, 1e9));
      expect(items.length).toBeGreaterThanOrEqual(10); // at least the final partial window of each cycle
      for (const it of items) expect(validProfile(it.profile), JSON.stringify(validProfile.errors)).toBe(true);
      expect(p.debug().counters.errors).toBe(0);
      expect(queue.counters().profilesDropped).toBe(0);
    } finally {
      tracker.dispose();
    }
  });
});

describe('shutdown', () => {
  it('stop() flushes the partial window (final record), disconnects, leaves no timer and offers nothing afterwards', async (ctx) => {
    skipIfBusyWait(ctx);
    const disconnect = vi.spyOn(inspector.Session.prototype, 'disconnect');
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 100 });
      const p = profilerOn(queue, 10_000); // no rotation will happen: only the final flush
      await p.start();
      busy(120);
      await sleep(30);
      await p.stop();
      const w = p.debug().windows;
      expect(w).toHaveLength(1);
      expect(w[0].final).toBe(true);
      expect(w[0].accepted).toBe(true);
      expect(disconnect).toHaveBeenCalled();
      const items = profilesOf(queue.drain(10, 1e9));
      expect(items).toHaveLength(1);
      expect(items[0].profile.sampleCount + (items[0].profile.idleSampleCount ?? 0)).toBeGreaterThan(5);
      expect(validProfile(items[0].profile)).toBe(true);
      await sleep(50);
      expect(await tracker.leakedSince(before)).toEqual([]);
      expect(queue.depth()).toBe(0);
    } finally {
      tracker.dispose();
    }
  });

  it('stop() during a backoff pause or before start never throws and leaves no timer', async (ctx) => {
    skipIfBusyWait(ctx);
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const queue = new BoundedTelemetryQueue();
      const never = profilerOn(queue, 50);
      await expect(never.stop()).resolves.toBeUndefined();
      const p = profilerOn(queue, 30, { maxStallMs: 0 }); // every window is over budget: backoff after 3 windows
      await p.start();
      await until(() => p.profilerHealth().state === 'backoff');
      await p.stop();
      expect(p.profilerHealth().state).toBe('stopped');
      await sleep(80);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });
});

describe('profiler disabled: zero overhead path', () => {
  it('enabled:false opens no inspector session, arms no timer, produces nothing and reports state disabled', async () => {
    const connect = vi.spyOn(inspector.Session.prototype, 'connect');
    const tracker = new TimerLeakTracker();
    try {
      const before = tracker.snapshot();
      const queue = new BoundedTelemetryQueue();
      let probed = 0;
      let sessions = 0;
      const p = new ContinuousProfiler(
        { enabled: false, windowMs: 20 },
        {
          queue,
          serviceName: 'm06',
          instanceId: 'm06-1',
          probe: () => {
            probed++;
            return { available: true };
          },
          createSession: () => {
            sessions++;
            throw new Error('must not be created');
          },
        },
      );
      expect(p.profilerHealth().state).toBe('disabled');
      await p.start();
      await sleep(80);
      await p.stop();
      expect(p.profilerHealth().state).toBe('disabled');
      expect(p.profilerHealth().reason).toMatch(/enabled is false/);
      expect([probed, sessions, connect.mock.calls.length]).toEqual([0, 0, 0]);
      expect(queue.depth()).toBe(0);
      expect(p.debug().windows).toHaveLength(0);
      expect(await tracker.leakedSince(before)).toEqual([]);
    } finally {
      tracker.dispose();
    }
  });
});

describe('profile pool boundedness and no network', () => {
  it('against a queue nobody drains, the profile pool never exceeds maxQueuedProfiles; every overflow is counted exactly once', async (ctx) => {
    skipIfBusyWait(ctx);
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 3 });
    const p = profilerOn(queue, 25);
    await p.start();
    let maxDepth = 0;
    const watch = setInterval(() => (maxDepth = Math.max(maxDepth, queue.depth('profile'))), 5);
    await until(() => p.debug().counters.profilesOffered >= 14, 15_000);
    clearInterval(watch);
    await p.stop();
    const c = p.debug().counters;
    expect(maxDepth).toBeLessThanOrEqual(3);
    expect(queue.depth('profile')).toBe(3);
    expect(queue.estimatedBytes('profile')).toBeGreaterThan(0);
    expect(c.profilesRejected).toBe(c.profilesOffered - 3);
    expect(queue.counters().profilesDropped).toBe(c.profilesRejected);
    expect(queue.depth('trace')).toBe(0);
  });

  it('profiler + metrics collector make no network call (net, tls, http(s), fetch, dns)', async (ctx) => {
    skipIfBusyWait(ctx);
    const spies = {
      'net.Socket.prototype.connect': vi.spyOn(net.Socket.prototype, 'connect'),
      'tls.connect': vi.spyOn(tls, 'connect'),
      'http.request': vi.spyOn(http, 'request'),
      'https.request': vi.spyOn(https, 'request'),
      'globalThis.fetch': vi.spyOn(globalThis, 'fetch'),
      'dns.lookup': vi.spyOn(dns, 'lookup'),
    };
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 50 });
    const p = profilerOn(queue, 30);
    const m = new MetricsCollector({ intervalMs: 25 }, { queue, serviceName: 'm06', instanceId: 'm06-1' });
    live.push({ stop: () => m.stop() });
    await p.start();
    m.start();
    busy(100);
    await until(() => p.debug().counters.windows >= 4 && m.debug().intervals >= 4);
    m.stop();
    await p.stop();
    const items = queue.drain(1000, 1e9);
    expect(profilesOf(items).length).toBeGreaterThanOrEqual(4);
    const metrics = items.filter((i): i is MetricItem => i.type === 'metric');
    expect(metrics.length).toBeGreaterThanOrEqual(4);
    for (const mi of metrics) expect(validMetric(mi.metric), JSON.stringify(validMetric.errors)).toBe(true);
    for (const [name, spy] of Object.entries(spies)) expect(spy, name).not.toHaveBeenCalled();
  });
});

describe('inspector integration: other sessions and the host console', () => {
  it("a host's own inspector.Session with Profiler enabled and a profile running coexists: no crash, Tracelet keeps rotating, the host profile is intact", async (ctx) => {
    skipIfBusyWait(ctx);
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 100 });
    const host = new inspector.Session();
    host.connect();
    const post = (m: string, params?: object): Promise<any> =>
      new Promise((resolve, reject) => host.post(m as never, params as never, ((e: Error | null, r?: unknown) => (e ? reject(e) : resolve(r))) as never));
    const rejections: unknown[] = [];
    const onRej = (e: unknown): number => rejections.push(e);
    process.on('unhandledRejection', onRej);
    const p = profilerOn(queue, 60);
    try {
      await post('Profiler.enable');
      await post('Profiler.start');
      await p.start();
      expect(p.profilerHealth().state).toBe('running');
      for (let i = 0; i < 8; i++) {
        busy(40);
        await sleep(30);
      }
      await until(() => p.debug().counters.windows >= 4);
      const d = p.debug();
      const state = p.profilerHealth().state;
      // behaviour record: with a foreign enabled Profiler the keep-alive (console.profile) is also delivered to the host session
      expect(['running', 'backoff']).toContain(state);
      expect(d.keepAlive).toBe('active');
      expect(d.counters.errors).toBe(0);
      for (const w of d.windows) {
        expect(Number.isFinite(w.keepAliveMs)).toBe(true);
        expect(w.keepAliveMs).toBeLessThanOrEqual(w.startStallMs + w.stopStallMs + 1);
      }
      const hostProfile = (await post('Profiler.stop')).profile as { nodes: unknown[]; samples?: number[] };
      expect(Array.isArray(hostProfile.nodes)).toBe(true);
      expect((hostProfile.samples ?? []).length).toBeGreaterThan(0);
      // Tracelet is unaffected by the host stopping ITS profile
      const windows = p.debug().counters.windows;
      await until(() => p.debug().counters.windows >= windows + 2);
      expect(p.debug().counters.errors).toBe(0);
      for (const it of profilesOf(queue.drain(1000, 1e9))) expect(validProfile(it.profile)).toBe(true);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
      await p.stop();
      try {
        await post('Profiler.disable');
      } catch {
        // already stopped
      }
      host.disconnect();
    }
  });

  it("a host's Session that enables the Profiler and disconnects abruptly mid-run does not disturb Tracelet", async (ctx) => {
    skipIfBusyWait(ctx);
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 100 });
    const p = profilerOn(queue, 40);
    await p.start();
    const host = new inspector.Session();
    host.connect();
    host.post('Profiler.enable');
    host.post('Profiler.start');
    busy(60);
    host.disconnect(); // Profiler.disable is implied by the disconnect
    await until(() => p.debug().counters.windows >= 4);
    expect(p.profilerHealth().state).toBe('running');
    expect(p.debug().counters.errors).toBe(0);
  });

  it("a host console.profile('x') without profileEnd does not break rotation; the open host profile is cleaned up with profileEnd", async (ctx) => {
    skipIfBusyWait(ctx);
    const queue = new BoundedTelemetryQueue({ maxQueuedProfiles: 100 });
    const p = profilerOn(queue, 40);
    await p.start();
    // node's global console.profile IS the V8 inspector console method (verified: console.profile === inspector.console.profile in
    // plain node); vitest replaces the global console in its worker, so the V8 console is used directly here
    const v8Console = inspector.console as unknown as { profile(t: string): void; profileEnd(t: string): void };
    expect(typeof v8Console.profile).toBe('function');
    try {
      v8Console.profile('host-x');
      for (let i = 0; i < 6; i++) {
        busy(30);
        await sleep(25);
      }
      await until(() => p.debug().counters.windows >= 5);
      expect(p.profilerHealth().state).toBe('running');
      expect(p.debug().counters.errors).toBe(0);
      expect(p.debug().keepAlive).toBe('active');
      for (const it of profilesOf(queue.drain(1000, 1e9))) expect(validProfile(it.profile)).toBe(true);
    } finally {
      v8Console.profileEnd('host-x');
    }
    // after the host closes its profile, rotation still works
    const windows = p.debug().counters.windows;
    await until(() => p.debug().counters.windows >= windows + 2);
    expect(p.debug().counters.errors).toBe(0);
  });
});
