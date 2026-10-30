import { types } from 'node:util';
import { forwardRef, Inject, Injectable, Module, Scope } from '@nestjs/common';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';
import { Observable, firstValueFrom, of } from 'rxjs';
import { delay, map } from 'rxjs/operators';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trace } from '../../../src/context/index.js';
import type { TraceItem } from '../../../src/contracts/index.js';
import { createAppFor, sleep } from '../../support/instrumentation/orders-app.js';
import { startHarness, type Harness } from '../../support/instrumentation/harness.js';
import type { INestApplicationContext } from '@nestjs/common';

/*
 * T06-T08 decision (Mission 03). These assert the CURRENT behaviour on Nest 11.x as gating facts; the supported and
 * unsupported lists are in artifacts/03_INSTRUMENTATION_REPORT.md. If a Nest upgrade changes one of them, this file fails and
 * the list must be revisited (a "better" result is still a change to document). Business results are always asserted.
 */

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
class ReqDep {
  work(): string {
    return 'dep';
  }
}
@Injectable({ scope: Scope.REQUEST })
class ReqScoped {
  constructor(@Inject(ReqDep) readonly dep: ReqDep) {}
  work(): string {
    return `req:${this.dep.work()}`;
  }
}
@Injectable({ scope: Scope.TRANSIENT })
class Transient {
  work(): string {
    return 'transient';
  }
}

@Injectable()
class RequestFacade {
  constructor(@Inject(ModuleRef) private readonly moduleRef: ModuleRef) {}
  /** What an HTTP/transport request pipeline does: one contextId per request, resolve the scoped provider through it. */
  async handle(): Promise<string> {
    const ctxId = ContextIdFactory.create();
    const scoped = await this.moduleRef.resolve(ReqScoped, ctxId);
    return scoped.work();
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
    return of(1, 2, 3).pipe(delay(40), map((n) => n * 2));
  }
  async *iterate(): AsyncGenerator<number> {
    for (let i = 0; i < 3; i++) {
      await sleep(20);
      yield i;
    }
  }
}

class FactoryMade {
  work(): string {
    return 'factory';
  }
}

@Module({
  providers: [
    { provide: 'FACTORY', useFactory: () => new FactoryMade() },
    { provide: 'VALUE', useValue: { work: (): string => 'value' } },
    FwdA, FwdB, ReqDep, ReqScoped, Transient, RequestFacade,
    PrivateKeeper,
    Exotic,
    Streams,
  ],
})
class EdgeModule {}

describe('T06-T08 edge providers (current behaviour, gating)', () => {
  let h: Harness;
  let app: INestApplicationContext;

  beforeAll(async () => {
    h = startHarness({ completionTimeoutMs: 200 });
    app = await createAppFor(EdgeModule);
  });
  afterAll(async () => {
    await app.close();
    h.stop();
  });

  /** Runs `fn` in its own root and returns the result plus the stored operations (root excluded) and the trace item. */
  async function run<T>(name: string, fn: () => T | Promise<T>): Promise<{ result: T; ops: string[]; item: TraceItem }> {
    const before = h.items.length;
    const result = await trace(name, async () => fn(), { kind: 'custom' });
    await h.settle();
    const item = h.items[before];
    return { result, ops: item.spans.filter((s) => s.parentSpanId !== null).map((s) => s.operation), item };
  }

  it('T06 useFactory and useValue objects are proxied and traced (class name, or Object for a literal)', async () => {
    const factory = app.get<FactoryMade>('FACTORY');
    const value = app.get<{ work(): string }>('VALUE');
    const f = await run('factory', () => factory.work());
    expect(f.result).toBe('factory');
    expect(f.ops).toEqual(['FactoryMade.work']);
    const v = await run('value', () => value.work());
    expect(v.result).toBe('value');
    expect(v.ops).toEqual(['Object.work']);
  });

  it('T06 forwardRef: the entry call is traced, the call through the forwardRef-injected dependency is NOT (raw reference)', async () => {
    const a = await run('fwd.A', () => app.get(FwdA).callB());
    expect(a.result).toBe('A>B');
    expect(a.ops).toEqual(['FwdA.callB']);
    const b = await run('fwd.B', () => app.get(FwdB).callA());
    expect(b.result).toBe('B>A');
    expect(b.ops).toEqual(['FwdB.callA']);
    expect(types.isProxy(app.get(FwdA))).toBe(true);
    expect(types.isProxy((app.get(FwdA) as unknown as { b: object }).b)).toBe(false);
  });

  it('T06 request-scoped through a real contextId (ModuleRef.resolve, the HTTP/transport path): proxied and traced, with its dependencies', async () => {
    const { result, ops } = await run('req.facade', () => app.get(RequestFacade).handle());
    expect(result).toBe('req:dep');
    expect(ops).toEqual(['RequestFacade.handle', 'ReqScoped.work', 'ReqDep.work']);
    const ctxId = ContextIdFactory.create();
    const scoped = await app.get(ModuleRef).resolve(ReqScoped, ctxId);
    expect(types.isProxy(scoped)).toBe(true);
    expect(types.isProxy(scoped.dep)).toBe(true);
  });

  it('T06 request-scoped and transient obtained through app.resolve() (no contextId): NOT proxied, no span, results unchanged', async () => {
    const req = await app.resolve(ReqScoped);
    expect(types.isProxy(req)).toBe(false);
    const r = await run('req.appresolve', () => req.work());
    expect(r.result).toBe('req:dep');
    expect(r.ops).toEqual([]);

    const transient = await app.resolve(Transient);
    expect(types.isProxy(transient)).toBe(false);
    const t = await run('transient.appresolve', () => transient.work());
    expect(t.result).toBe('transient');
    expect(t.ops).toEqual([]);
  });

  it('T07 #private class: the entry call is traced, the nested this.helper() is not (raw receiver)', async () => {
    const { result, ops } = await run('private', () => app.get(PrivateKeeper).run());
    expect(result).toBe(42);
    expect(ops).toEqual(['PrivateKeeper.run']);
  });

  it('T07 symbol-keyed methods are traced, getters are not methods, plain methods are traced', async () => {
    const exotic = app.get(Exotic);
    const sym = await run('sym', () => exotic[SYM]());
    expect(sym.result).toBe('sym');
    expect(sym.ops).toEqual([`Exotic.Symbol(edge.symMethod)`]);
    const getter = await run('getter', () => exotic.computed);
    expect(getter.result).toBe(5);
    expect(getter.ops).toEqual([]);
    const plain = await run('plain', () => exotic.plain());
    expect(plain.result).toBe('plain');
    expect(plain.ops).toEqual(['Exotic.plain']);
  });

  it('T08 Observable: the span ends at return time (unsupported beyond that), the subscription result is unchanged', async () => {
    const streams = app.get(Streams);
    const { result, ops, item } = await run('observable', () => firstValueFrom(streams.observable()));
    expect(result).toBe(2);
    expect(ops).toEqual(['Streams.observable']);
    const span = item.spans.find((s) => s.operation === 'Streams.observable')!;
    expect(item.trace.durationMs - span.durationMs).toBeGreaterThanOrEqual(30); // the emission takes >= 40 ms AFTER the span ended (relative: load-robust)
    expect(item.trace.durationMs).toBeGreaterThan(35);
  });

  it('T08 async iterable / async generator: the span ends at return time (unsupported beyond that)', async () => {
    const streams = app.get(Streams);
    const { result, ops, item } = await run('async-iterable', async () => {
      const seen: number[] = [];
      for await (const n of streams.iterate()) seen.push(n);
      return seen;
    });
    expect(result).toEqual([0, 1, 2]);
    expect(ops).toEqual(['Streams.iterate']);
    const span = item.spans.find((s) => s.operation === 'Streams.iterate')!;
    expect(item.trace.durationMs - span.durationMs).toBeGreaterThanOrEqual(40); // the iteration takes >= 60 ms AFTER the span ended (relative: load-robust)
    expect(item.trace.durationMs).toBeGreaterThan(50);
  });
});
