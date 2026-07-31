export function canonicalNotificationJson(value: unknown): string {
  return serialize(value, new Set());
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') throw new Error('non-JSON value');
  if (ancestors.has(value)) throw new Error('circular value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => serialize(item, ancestors)).join(',')}]`;
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('non-plain object');
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${serialize(item, ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

