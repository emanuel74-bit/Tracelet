import { heavyQueryLimiter } from './concurrency-limiter';
import { TraceRepository } from '../query/trace.repository';
import { ProfileRepository } from '../query/profile.repository';
import { RollupRepository } from '../query/rollup.repository';
import { ErrorRepository } from '../query/error.repository';
import { InstanceRepository } from '../query/instance.repository';
import { createQueryRuntime } from '../query/base.repository';
import type { QueryServiceOptions, TraceQuery } from '../query/base.repository';
import type { TelemetryCollections } from '../query/base.repository';
export { QueryError } from '../query/filters';
export class QueryService extends TraceRepository {
  private readonly profile: ProfileRepository;
  private readonly rollup: RollupRepository;
  private readonly error: ErrorRepository;
  private readonly instance: InstanceRepository;
  constructor(collections: TelemetryCollections, options: QueryServiceOptions = {}) {
    const runtime = createQueryRuntime(); runtime.limiter = heavyQueryLimiter; super(collections, options, runtime);
    this.profile = new ProfileRepository(collections, options, runtime);
    this.rollup = new RollupRepository(collections, options, runtime);
    this.error = new ErrorRepository(collections, options, runtime);
    this.instance = new InstanceRepository(collections, options, runtime);
  }
  profiles(q: TraceQuery) { return this.profile.profiles(q); }
  flamegraph(id: string) { return this.profile.flamegraph(id); }
  mergedFlamegraph(q: TraceQuery) { return this.profile.mergedFlamegraph(q); }
  overview(q: TraceQuery) { return this.rollup.overview(q); }
  methods(q: TraceQuery) { return this.rollup.methods(q); }
  errors(q: TraceQuery) { return this.error.errors(q); }
  services() { return this.instance.services(); }
  instances(service?: string) { return this.instance.instances(service); }
  health() { return this.instance.health(); }
}
