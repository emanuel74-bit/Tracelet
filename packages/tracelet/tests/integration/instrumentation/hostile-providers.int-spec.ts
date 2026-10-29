// Ported from nestjs/observe@7500fba (MIT, Copyright (c) 2017-present Kamil Mysliwiec): src/instrument/hostile-providers.int-spec.ts
// Changes: no HTTP controllers or supertest (Tracelet has no auto HTTP roots); the nestjs-cls case is reproduced with a
// hand-built strict Proxy provider (nestjs-cls is not a devDependency); the module-namespace and promise-with-members cases
// call the provider inside trace(). See third_party/nestjs-observe/FORK_DELTA.instrumentation.md
import { types } from 'node:util';
import { Inject, Injectable, Module } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trace } from '../../../src/context/index.js';
import { createAppFor } from '../../support/instrumentation/orders-app.js';
import { startHarness, type Harness } from '../../support/instrumentation/harness.js';
import type { INestApplicationContext } from '@nestjs/common';

/** Like nestjs-cls' CLS_REQ / CLS_RES: any property outside a small allowlist throws while no context is active. */
class ProxyProviderNotResolvedError extends Error {}
/** What Nest itself reads from every provider (lifecycle hooks, thenable check); nestjs-cls allows these too. */
const ALLOWED = new Set(['then', 'onModuleInit', 'onApplicationBootstrap', 'onModuleDestroy', 'beforeApplicationShutdown', 'onApplicationShutdown']);
const strictProxy = new Proxy(
  {},
  {
    get(_target, prop) {
      if (typeof prop === 'symbol' || ALLOWED.has(prop)) return undefined;
      throw new ProxyProviderNotResolvedError(`strict proxy: property ${String(prop)} read outside a context`);
    },
  },
);

// A native ES module namespace has no prototype, so no `constructor` (a data: import needs top-level await, unavailable in this CJS test build).
const utilsNamespace = { greet: (name: string): string => `hello ${name}` } as { greet: (name: string) => string };
Object.setPrototypeOf(utilsNamespace, null); // like a native ES module namespace: no prototype, so no `constructor`

/** A request object in the style of `got`: a promise that also has methods. */
@Injectable()
class HttpClientLikeProvider {
  get() {
    return Object.assign(Promise.resolve('raw'), { json: async () => ({ ok: true }) });
  }
}

@Injectable()
class StatusService {
  constructor(
    @Inject('CLS_REQ') readonly req: object,
    @Inject('UTILS') private readonly utils: typeof utilsNamespace,
    @Inject(HttpClientLikeProvider) private readonly client: HttpClientLikeProvider,
  ) {}
  status(): { ok: boolean } {
    return { ok: true };
  }
  greet(): string {
    return this.utils.greet('you');
  }
  upstream() {
    return this.client.get().json();
  }
}

@Module({
  providers: [
    { provide: 'CLS_REQ', useValue: strictProxy },
    { provide: 'CLS_RES', useValue: strictProxy },
    { provide: 'UTILS', useValue: utilsNamespace },
    HttpClientLikeProvider,
    StatusService,
  ],
})
class HostileModule {}

describe('hostile providers next to the Tracelet instrument', () => {
  let h: Harness;
  let app: INestApplicationContext;

  beforeAll(async () => {
    h = startHarness({ completionTimeoutMs: 100 });
    // nestjs/nest#17553 scenario: the container hands every provider, strict proxies included, to the instance decorator,
    // and bootstrap always runs outside a context. The decorator must not crash the bootstrap.
    app = await createAppFor(HostileModule);
  });
  afterAll(async () => {
    await app?.close();
    h?.stop();
  });

  it('boots with strict proxy providers registered and still instruments ordinary providers', async () => {
    const status = app.get(StatusService);
    expect(types.isProxy(status)).toBe(true);
    expect(await trace('status', async () => status.status())).toEqual({ ok: true });
    await h.settle();
    expect(h.items.at(-1)!.spans.map((s) => s.operation)).toContain('StatusService.status');
  });

  it('the strict proxy is left exactly as it was (not wrapped, still strict)', () => {
    const injected = app.get(StatusService).req;
    expect(injected).toBe(strictProxy);
    expect(() => (injected as { anything: unknown }).anything).toThrow(ProxyProviderNotResolvedError);
  });

  it('a module namespace registered as a value provider works inside a trace', async () => {
    const status = app.get(StatusService);
    expect(await trace('greet', async () => status.greet())).toBe('hello you');
    expect(app.get('UTILS').greet('x')).toBe('hello x');
    await h.settle();
  });

  it('a provider returning a promise with extra members keeps its members', async () => {
    const status = app.get(StatusService);
    expect(await trace('upstream', async () => status.upstream())).toEqual({ ok: true });
    const client = app.get(HttpClientLikeProvider);
    const returned = trace('direct', () => client.get());
    expect(typeof (returned as unknown as { json: unknown }).json).toBe('function');
    await expect(returned.json()).resolves.toEqual({ ok: true });
    await h.settle();
  });
});
