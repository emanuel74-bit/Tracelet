import { projectDto } from '../query/filters';

export function mapResponse(value: unknown, path: string): unknown {
  const names: Record<string, string> = { '/traces': 'TracePage', '/profiles': 'ProfileSummaryPage', '/services': 'ServiceList', '/instances': 'InstanceList', '/overview': 'Overview', '/methods': 'MethodStatsList', '/errors': 'ErrorGroupPage', '/health': 'Health', '/flamegraph': 'Flamegraph' };
  const name = names[path] ?? (path.startsWith('/traces/') ? 'TraceDetail' : 'Flamegraph');
  return projectDto(value, name);
}
