import schema from '../contracts/telemetry.schema.json';
import type { ApiErrorCode } from '../contracts/observe-contracts';

export class QueryError extends Error {
  constructor(public readonly code: ApiErrorCode, public readonly status: number, message: string) { super(message); }
}

type Shape = { $ref?: string; type?: string; properties?: Record<string, Shape>; items?: Shape; additionalProperties?: boolean | Shape };
const definitions = schema.$defs as unknown as Record<string, Shape>;

/** Project recursively using the frozen DTO properties, including nested objects. */
function project(value: unknown, shape: Shape): unknown {
  if (shape.$ref) return project(value, definitions[shape.$ref.split('/').at(-1)!]!);
  if (value instanceof Date) return value.toISOString();
  if (shape.type === 'array') return Array.isArray(value) ? value.map(v => project(v, shape.items!)) : [];
  if (shape.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const source = value as Record<string, unknown>;
    const fields = shape.properties ?? {};
    return Object.fromEntries(Object.entries(source).flatMap(([key, v]) => {
      const child = (Object.hasOwn(fields, key) ? fields[key] : undefined) ?? (typeof shape.additionalProperties === 'object' ? shape.additionalProperties : undefined);
      return child && v !== undefined ? [[key, project(v, child)]] : [];
    }));
  }
  // Attribute maps permit scalar values only; never pass an unknown object through.
  return value === null || ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
}
export const projectDto = <T>(value: unknown, name: string): T => project(value, definitions[name]!) as T;
export const escapeSearch = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
