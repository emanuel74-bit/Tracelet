import { describe, expect, it } from 'vitest';
import { queryFor, queryKey, readState, writeState } from '../../src/state';
const now = Date.parse('2026-10-30T01:00:00Z');
describe('URL diagnostic state', () => {
  it('resolves a fixed default window once and round trips every deep link filter', () => {
    const state = readState('?view=traces&service=event+worker&instanceId=pod-a&status=error&search=Handler.run&id=trace-0001', now);
    expect(state.from).toBe('2026-10-30T00:00:00.000Z'); expect(state.to).toBe('2026-10-30T01:00:00.000Z');
    expect(readState(writeState(state), now + 60000)).toEqual(state);
    expect(queryFor(state)).toEqual({ from: state.from, to: state.to, service: 'event worker', instanceId: 'pod-a' });
    expect(queryFor(state)).not.toHaveProperty('search'); expect(queryFor(state)).not.toHaveProperty('status');
  });
  it('drops invalid view, IDs, status and oversized inputs and repairs unusable windows', () => {
    const state = readState('?view=bad&instanceId=$bad&id=../secret&status=bad&from=invalid&to=invalid&service=' + 'a'.repeat(129), now);
    expect(state).toEqual({ view: 'overview', from: '2026-10-30T00:00:00.000Z', to: '2026-10-30T01:00:00.000Z' });
    expect(readState('?from=2026-10-01T00:00:00Z&to=2026-10-30T00:00:00Z', now).to).toBe(new Date(now).toISOString());
  });
  it('normalizes error deep links to their last 24 hours and serializes the actual window', () => {
    const state = readState('?view=errors&from=2026-10-27T01:00:00Z&to=2026-10-30T01:00:00Z', now);
    expect(state.from).toBe('2026-10-29T01:00:00.000Z');
    expect(state.to).toBe('2026-10-30T01:00:00.000Z');
    expect(readState(writeState(state), now + 1000)).toEqual(state);
  });
  it('keys pagination populations by route, complete bounds and literal filter values', () => {
    const a = queryKey('traces', { service: 'a', from: 'one', to: 'two', search: 'Handler', status: 'error' });
    expect(queryKey('traces', { to: 'two', from: 'one', status: 'error', search: 'Handler', service: 'a' })).toBe(a);
    for (const delta of [{ service: 'b' }, { from: 'other' }, { to: 'other' }, { search: 'other' }, { status: 'ok' }]) expect(queryKey('traces', { service: 'a', from: 'one', to: 'two', search: 'Handler', status: 'error', ...delta })).not.toBe(a);
    expect(queryKey('errors', { service: 'a', from: 'one', to: 'two', search: 'Handler', status: 'error' })).not.toBe(a);
    expect(writeState(readState('', now))).not.toContain('cursor');
  });
});
