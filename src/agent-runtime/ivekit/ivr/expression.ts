import { IvrError } from './errors.js';

export function renderIvrTemplate(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value !== 'string') return cloneBounded(value);
  const output = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.:-]{0,127})\}/g, (_match, name: string) => (
    scalarString(variables[name])
  ));
  if (output.length > 8_192) throw validationError();
  return output;
}

export function evaluateIvrCondition(
  data: Record<string, unknown>,
  variables: Record<string, unknown>
): boolean {
  const name = requiredName(data.variable ?? data.variableName);
  const actual = variables[name];
  const expected = renderIvrTemplate(data.value, variables);
  const operator = String(data.operator ?? 'equals');
  switch (operator) {
    case 'equals': return scalarString(actual) === scalarString(expected);
    case 'not_equals': return scalarString(actual) !== scalarString(expected);
    case 'contains': return scalarString(actual).includes(scalarString(expected));
    case 'starts_with': return scalarString(actual).startsWith(scalarString(expected));
    case 'ends_with': return scalarString(actual).endsWith(scalarString(expected));
    case 'gt': return finiteNumber(actual) > finiteNumber(expected);
    case 'gte': return finiteNumber(actual) >= finiteNumber(expected);
    case 'lt': return finiteNumber(actual) < finiteNumber(expected);
    case 'lte': return finiteNumber(actual) <= finiteNumber(expected);
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    case 'not_exists': return actual === undefined || actual === null || actual === '';
    default: throw validationError();
  }
}

export function boundedVariableName(value: unknown): string {
  return requiredName(value);
}

function requiredName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw validationError();
  }
  return value;
}

function scalarString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw validationError();
}

function finiteNumber(value: unknown): number {
  const output = Number(value);
  if (!Number.isFinite(output)) throw validationError();
  return output;
}

function cloneBounded(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > 8_192) throw validationError();
  return JSON.parse(serialized) as unknown;
}

function validationError(): IvrError {
  return new IvrError({ code: 'validation_failed', status: 422 });
}
