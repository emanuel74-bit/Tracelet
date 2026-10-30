import type { Query } from './api';
export const views = ['overview', 'methods', 'traces', 'profiler', 'errors', 'health'] as const;
export type View = typeof views[number];
export interface DashboardState { view: View; service?: string; instanceId?: string; from: string; to: string; status?: 'ok' | 'error' | 'incomplete'; search?: string; id?: string }
const text = (value: string | null, max = 128): string | undefined => value && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : undefined;
export function readState(search: string, now = Date.now()): DashboardState {
  const q = new URLSearchParams(search);
  const view = views.includes(q.get('view') as View) ? q.get('view') as View : 'overview';
  let to = q.get('to') ? Date.parse(q.get('to')!) : now;
  let from = q.get('from') ? Date.parse(q.get('from')!) : to - 3600000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 7 * 86400000) { to = now; from = now - 3600000; }
  const status = q.get('status');
  const instance = text(q.get('instanceId'));
  const id = text(q.get('id'));
  if (view === 'errors' && to - from > 86400000) from = to - 86400000;
  return { view, from: new Date(from).toISOString(), to: new Date(to).toISOString(), ...(text(q.get('service')) ? { service: text(q.get('service')) } : {}), ...(instance && /^[A-Za-z0-9._:-]+$/.test(instance) ? { instanceId: instance } : {}), ...(['ok', 'error', 'incomplete'].includes(status ?? '') ? { status: status as DashboardState['status'] } : {}), ...(text(q.get('search')) ? { search: text(q.get('search')) } : {}), ...(id && /^[A-Za-z0-9._:-]+$/.test(id) ? { id } : {}) };
}
export function writeState(state: DashboardState): string {
  const q = new URLSearchParams();
  for (const key of ['view', 'service', 'instanceId', 'from', 'to', 'status', 'search', 'id'] as const) if (state[key] !== undefined && state[key] !== '') q.set(key, state[key]!);
  return '?' + q.toString();
}
export const queryFor = (state: DashboardState): Readonly<Record<string, string | undefined>> => ({ service: state.service, instanceId: state.instanceId, from: state.from, to: state.to });
export function updateUrl(state: DashboardState, replace = false): void {
  window.history[replace ? 'replaceState' : 'pushState']({}, '', window.location.pathname + writeState(state) + window.location.hash);
}
/** Cursor stacks are keyed by the complete query population; changing any filter starts at page one. */
export const queryKey = (route: string, query: Query): string => JSON.stringify([route, ...Object.keys(query).filter(k => query[k] !== undefined).sort().map(k => [k, query[k]])]);
