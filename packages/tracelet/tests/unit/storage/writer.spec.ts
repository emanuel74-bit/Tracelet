import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { TelemetryItem, TelemetryQueue } from '../../../src/contracts/tracelet-internal-contracts';
import { traceletAls } from '../../../src/shared/als';
import { BoundedTelemetryWriter, type TelemetryStore } from '../../../src/storage/telemetry-writer';
import { HeartbeatWriter } from '../../../src/storage/heartbeat-writer';

const item = (type: TelemetryItem['type']): TelemetryItem => ({ type, estimatedBytes: 10 }) as TelemetryItem;
function queue(items: TelemetryItem[]) {
  return { drain: vi.fn((max: number) => items.splice(0, max)), depth: () => items.length, reportDropped: vi.fn(), waitForItems: vi.fn(() => Promise.resolve()) } as unknown as TelemetryQueue;
}
const options = { batchItems: 10, batchBytes: 1024, flushIntervalMs: 100, retryLimit: 0, shutdownTimeoutMs: 100, maxWriteDocsPerSecond: 2 };
const store = (write: TelemetryStore['write']): TelemetryStore => ({ write, storageHealth: () => ({ connected: true }) });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('bounded writer', () => {
  it('counts each dropped item but logs repeated failures once without driver payloads or trace context', async () => {
    vi.useFakeTimers();
    const contexts: unknown[] = [];
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => { contexts.push(traceletAls.getStore()); });
    const q = queue([item('trace'), item('profile')]);
    const writer = new BoundedTelemetryWriter(q, store(async () => { throw new Error('mongodb://user:secret@example'); }), options);
    await traceletAls.run(new Map([['business', true]]), () => writer.flush());
    expect(q.reportDropped).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(contexts).toEqual([undefined]);
  });
  it('counts all pools including drained in-flight items exactly once at shutdown, and late completion cannot resume writes', async () => {
    vi.useFakeTimers();
    const items = [item('trace'), item('profile'), item('rollup'), item('metric')];
    const q = queue([...items]);
    let complete!: () => void;
    const write = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const writer = new BoundedTelemetryWriter(q, store(write), options);
    const flush = writer.flush(); await vi.advanceTimersByTimeAsync(0);
    const shutdown = writer.shutdown(); await vi.advanceTimersByTimeAsync(100); await shutdown;
    expect(q.reportDropped).toHaveBeenCalledTimes(1);
    expect(q.reportDropped).toHaveBeenCalledWith(items, 'shutdown');
    complete(); await flush; await writer.shutdown();
    expect(write).toHaveBeenCalledTimes(1); expect(q.reportDropped).toHaveBeenCalledTimes(1);
    await writer.flush(); expect(write).toHaveBeenCalledTimes(1);
  });
  it('paces every document of the first item and detaches store callbacks from ALS', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const timestamps: number[] = []; const contexts: unknown[] = [];
    const q = queue([item('trace')]);
    const writer = new BoundedTelemetryWriter(q, store(async (_item, beforeWrite) => {
      contexts.push(traceletAls.getStore());
      for (let i = 0; i < 3; i++) { await beforeWrite(); timestamps.push(Date.now()); contexts.push(traceletAls.getStore()); }
    }), options);
    const flush = traceletAls.run(new Map([['business', true]]), () => writer.flush());
    await vi.advanceTimersByTimeAsync(0); expect(timestamps).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1000); await flush;
    expect(timestamps).toEqual([0, 500, 1000]); expect(contexts.every(c => c === undefined)).toBe(true);
  });
  it('retries with full jitter and drops a failed item once', async () => {
    vi.useFakeTimers(); const q = queue([item('profile')]);
    const write = vi.fn().mockRejectedValue(new Error('offline'));
    const writer = new BoundedTelemetryWriter(q, store(write), { ...options, retryLimit: 2, random: () => 1 });
    const flush = writer.flush(); await vi.advanceTimersByTimeAsync(1500); await flush;
    expect(write).toHaveBeenCalledTimes(3); expect(q.reportDropped).toHaveBeenCalledTimes(1);
    expect(q.reportDropped).toHaveBeenCalledWith([expect.objectContaining({ type: 'profile' })], 'storage');
  });
  it('caps retries by the 30 s batch age', async () => {
    vi.useFakeTimers(); const q = queue([item('metric')]);
    const write = vi.fn().mockRejectedValue(new Error('offline'));
    const writer = new BoundedTelemetryWriter(q, store(write), { ...options, retryLimit: 10, random: () => 1 });
    const flush = writer.flush(); await vi.advanceTimersByTimeAsync(30000); await flush;
    expect(write.mock.calls.length).toBeLessThan(11); expect(q.reportDropped).toHaveBeenCalledTimes(1);
  });
});
describe('heartbeat writer', () => {
  it('rate limits safe failure diagnostics while continuing the heartbeat cadence', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const writeHeartbeat = vi.fn().mockRejectedValue(new Error('mongodb://user:secret@example'));
    const heartbeat = new HeartbeatWriter({ writeHeartbeat }, () => ({} as never));
    heartbeat.start(); await vi.advanceTimersByTimeAsync(30000); heartbeat.stop();
    expect(writeHeartbeat).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
  });
  it('is detached, non-overlapping, repeats after 30 s and stops', async () => {
    vi.useFakeTimers(); const contexts: unknown[] = [];
    const writeHeartbeat = vi.fn(async () => { contexts.push(traceletAls.getStore()); });
    const factory = vi.fn(() => { contexts.push(traceletAls.getStore()); return {} as never; });
    const heartbeat = new HeartbeatWriter({ writeHeartbeat }, factory);
    traceletAls.run(new Map([['business', true]]), () => heartbeat.start());
    await vi.advanceTimersByTimeAsync(0); expect(writeHeartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000); expect(writeHeartbeat).toHaveBeenCalledTimes(2);
    heartbeat.stop(); await vi.advanceTimersByTimeAsync(30000); expect(writeHeartbeat).toHaveBeenCalledTimes(2);
    expect(contexts.every(c => c === undefined)).toBe(true);
  });
});
