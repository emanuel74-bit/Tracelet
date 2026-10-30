import { response, error } from './errors';
import type { ApiHandler, TraceletHttpRequest, TraceletHttpResponse } from '../contracts/tracelet-internal-contracts';
import { mapResponse } from './dto-mappers';
import { QueryError, QueryService } from './routes';

/** Integration passes the already-authorized request policy; absent/throwing policy denies. */
export interface QueryApiOptions { authorize?: (request: TraceletHttpRequest) => boolean | Promise<boolean> }
export function createQueryApiHandler(service: QueryService, options: QueryApiOptions = {}): ApiHandler {
  return async request => {
    const head = request.method.toUpperCase() === 'HEAD';
    const finish = (r: TraceletHttpResponse): TraceletHttpResponse => head ? { ...r, body: '' } : r;
    let authorized = false;
    try { authorized = options.authorize ? await options.authorize(request) : false; } catch { /* Default deny. */ }
    if (!authorized) return finish(error('FORBIDDEN', 'Observe access is not authorized', 403));
    const result = await service.withDiagnostics(async () => {
    try {
      if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) return error('METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported', 405);
      if (!request.path.startsWith('/api/v1/')) return finish(error('NOT_FOUND', 'Observe endpoint not found', 404));
      const path = request.path.slice('/api/v1'.length); const q = request.query; let body: unknown;
      if (path === '/traces') body = await service.traces(q);
      else if (/^\/traces\/[^/]+$/.test(path)) { service.validate(q, []); body = await service.trace(decodeURIComponent(path.slice('/traces/'.length))); }
      else if (path === '/services') { service.validate(q, []); body = await service.services(); }
      else if (path === '/instances') { service.validate(q, ['service']); body = await service.instances(q.service); }
      else if (path === '/overview') body = await service.overview(q);
      else if (path === '/methods') body = await service.methods(q);
      else if (path === '/errors') body = await service.errors(q);
      else if (path === '/profiles') body = await service.profiles(q);
      else if (path === '/flamegraph') body = await service.mergedFlamegraph(q);
      else if (/^\/profiles\/[^/]+\/flamegraph$/.test(path)) { service.validate(q, []); body = await service.flamegraph(decodeURIComponent(path.slice('/profiles/'.length, -'/flamegraph'.length))); }
      else if (path === '/health') { service.validate(q, []); body = await service.health(); }
      else return finish(error('NOT_FOUND', 'Observe endpoint not found', 404));
      return finish(body === null ? error('NOT_FOUND', 'Record not found', 404) : response(200, mapResponse(body, path)));
    } catch (e) {
      if (e instanceof QueryError) return finish(error(e.code, e.message, e.status));
      if (e instanceof URIError) return finish(error('INVALID_QUERY', 'Invalid resource identifier', 400));
      if (e && typeof e === 'object' && ('code' in e && e.code === 50 || 'codeName' in e && e.codeName === 'MaxTimeMSExpired')) return finish(error('QUERY_TIMEOUT', 'Storage query timed out', 503));
      return finish(error('STORAGE_UNAVAILABLE', 'Observe storage is unavailable', 503));
    }
    });
    return { ...result.value, headers: { ...result.value.headers, 'X-Tracelet-Skipped': String(result.skipped) } };
  };
}
