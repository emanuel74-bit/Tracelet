import { afterEach, describe, expect, it } from 'vitest';
import { resetRuntimeForTesting } from '../../../src/context/index.js';
import { runExample } from '../../../examples/direct-callback/main.js';

describe('examples/direct-callback runs and prints real captured spans', () => {
  afterEach(() => resetRuntimeForTesting());

  it('three messages: acks unchanged, one trace each with the provider chain, redacted error, rollup', async () => {
    const printed: string[] = [];
    const result = await runExample((line) => printed.push(line));

    expect(result.acks).toEqual(['ack:m-1', 'nack:m-2', 'ack:m-3']);
    expect(result.items).toHaveLength(3);
    expect(printed).toEqual(result.lines);

    const byStatus = (status: string) => result.items.filter((i) => i.trace.status === status);
    expect(byStatus('ok')).toHaveLength(2);
    expect(byStatus('error')).toHaveLength(1);

    const ok = byStatus('ok').find((i) => i.spans.length === 5)!; // two skus: two lookups
    expect(ok.spans.map((s) => s.operation).sort()).toEqual([
      'OrderConsumer.handle',
      'OrderService.total',
      'PriceRepository.lookup',
      'PriceRepository.lookup',
      'rabbitmq.consume',
    ]);
    expect(ok.trace.attributes).toEqual({ queue: 'orders' });
    expect(ok.trace.kind).toBe('rabbitmq');

    const failed = byStatus('error')[0];
    const origin = failed.spans.find((s) => s.sanitizedError)!;
    expect(origin.operation).toBe('PriceRepository.lookup');
    expect(origin.sanitizedError!.message).toContain('mongodb://[REDACTED]@db.internal');
    expect(JSON.stringify(failed)).not.toContain('s3cr3t');

    const op = result.rollups.flatMap((r) => r.operations).find((o) => o.operation === 'rabbitmq.consume')!;
    expect(op).toMatchObject({ count: 3, errorCount: 1, sampledCount: 3 });
    expect(result.lines.some((l) => l.includes('PriceRepository.lookup'))).toBe(true);
  });
});
