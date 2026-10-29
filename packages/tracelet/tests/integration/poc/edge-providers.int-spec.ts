import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { types } from 'node:util';
import { forwardRef, Inject, Injectable, Module, Scope } from '@nestjs/common';
import { Observable, firstValueFrom, of } from 'rxjs';
import { delay, map } from 'rxjs/operators';
import { afterAll, describe, expect, it } from 'vitest';
import { trace } from '../../../src/context/index.js';
import { createAppFor, sleep } from '../../support/instrumentation/orders-app.js';
import { startHarness } from '../../support/instrumentation/harness.js';

/* T06-T08: RECORD actual behaviour (not gating). The only hard assertions are that business results are unchanged. */

@Injectable()
class FwdA {
  constructor(@Inject(forwardRef(() => FwdB)) private readonly b: { name(): string }) {}
  callB(): string {
    return `A>${this.b.name()}`;
  }
  name(): string {
    return 'A';
  }
}
@Injectable()
class FwdB {
  constructor(@Inject(forwardRef(() => FwdA)) private readonly a: { name(): string }) {}
  name(): string {
    return 'B';
  }
  callA(): string {
    return `B>${this.a.name()}`;
  }
}

@Injectable({ scope: Scope.REQUEST })
class ReqScoped {
  work(): string {
    return 'req';
  }
}
@Injectable({ scope: Scope.TRANSIENT })
class Transient {
  work(): string {
    return 'transient';
  }
}

@Injectable()
class PrivateKeeper {
  #secret = 41;
  helper(): number {
    return this.#secret + 1;
  }
  run(): number {
    return this.helper(); // nested self-call: not traced for #private classes (raw receiver)
  }
}

const SYM = Symbol.for('edge.symMethod');
@Injectable()
class Exotic {
  [SYM](): string {
    return 'sym';
  }
  get computed(): number {
    return 5;
  }
  plain(): string {
    return 'plain';
  }
}

@Injectable()
class Streams {
  observable(): Observable<number> {
    return of(1, 2, 3).pipe(delay(15), map((n) => n * 2));
  }
  async *iterate(): AsyncGenerator<number> {
    for (let i = 0; i < 3; i++) {
      await sleep(5);
      yield i;
    }
  }
}

@Module({ providers: [FwdA, FwdB, ReqScoped, Transient, PrivateKeeper, Exotic, Streams] })
class EdgeModule {}

const recorded: Record<string, unknown> = {};

describe('T06-T08 edge providers (recorded, not gating)', () => {
  afterAll(() => {
    // vitest runs from packages/tracelet
    const out = resolve(process.cwd(), '../../artifacts/02_edge_providers.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ generatedBy: 'tests/integration/poc/edge-providers.int-spec.ts', nodeVersion: process.version, results: recorded }, null, 2));
  });

  it('records span output for each edge case', async () => {
    const h = startHarness({ completionTimeoutMs: 200 });
    const app = await createAppFor(EdgeModule);

    const ops = async (name: string, fn: () => unknown): Promise<unknown> => {
      const before = h.items.length;
      let result: unknown;
      let error: unknown;
      try {
        result = await trace(name, async () => fn(), { kind: 'custom' });
      } catch (e) {
        error = e;
      }
      const items = await h.settle();
      const item = items[before];
      recorded[name] = {
        result: error ? `threw: ${(error as Error).message}` : result,
        spans: item?.spans.map((s) => ({ op: s.operation, origin: s.origin, parent: item.spans.find((p) => p.spanId === s.parentSpanId)?.operation ?? null, durationMs: Math.round(s.durationMs * 10) / 10 })),
      };
      return result;
    };

    // T06 forwardRef pair
    expect(await ops('forwardRef.A>B', () => app.get(FwdA).callB())).toBe('A>B');
    expect(await ops('forwardRef.B>A', () => app.get(FwdB).callA())).toBe('B>A');

    // T06 request-scoped and transient providers
    const req = await app.resolve(ReqScoped);
    expect(await ops('request-scoped', () => req.work())).toBe('req');
    const transient = await app.resolve(Transient);
    expect(await ops('transient', () => transient.work())).toBe('transient');

    // Which instances did Nest's instrument hook actually proxy?
    recorded['isProxy (did Nest hand the instance to the instrument hook)'] = {
      singletonFwdA: types.isProxy(app.get(FwdA)),
      dependencyInjectedViaForwardRef: types.isProxy((app.get(FwdA) as unknown as { b: object }).b),
      requestScoped: types.isProxy(req),
      transient: types.isProxy(transient),
      privateClass: types.isProxy(app.get(PrivateKeeper)),
    };

    // T07 #private class (raw receiver; nested self-call not traced)
    expect(await ops('#private.run', () => app.get(PrivateKeeper).run())).toBe(42);

    // T07 symbol-keyed method and getter
    const exotic = app.get(Exotic);
    expect(await ops('symbol-keyed method', () => exotic[SYM]())).toBe('sym');
    expect(await ops('getter property', () => exotic.computed)).toBe(5);
    expect(await ops('plain method', () => exotic.plain())).toBe('plain');

    // T08 Observable and async iterable: the span ends at return time (documented unsupported)
    const streams = app.get(Streams);
    expect(await ops('observable', async () => firstValueFrom(streams.observable()))).toBe(2);
    expect(
      await ops('async-iterable', async () => {
        const seen: number[] = [];
        for await (const n of streams.iterate()) seen.push(n);
        return seen;
      }),
    ).toEqual([0, 1, 2]);

    await app.close();
    h.stop();
  });
});
