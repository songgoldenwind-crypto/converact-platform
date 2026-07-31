import type { JsonRecord } from '../integrations/provider-runtime-types.js';

export interface TemplateScopes {
  input?: JsonRecord;
  steps?: JsonRecord;
  nodes?: JsonRecord;
}

export function resolveInputTemplate(value: unknown, scopes: TemplateScopes = {}): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('$input.')) return readPath(scopes.input || {}, value.slice('$input.'.length));
    if (value.startsWith('$steps.')) return readPath(scopes.steps || {}, value.slice('$steps.'.length));
    if (value.startsWith('$nodes.')) return readPath(scopes.nodes || {}, value.slice('$nodes.'.length));
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => resolveInputTemplate(item, scopes));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveInputTemplate(item, scopes)]));
  }
  return value;
}

export function readPath(object: JsonRecord, path: string): unknown {
  return path.split('.').reduce((cursor, part) => cursor?.[part], object);
}
