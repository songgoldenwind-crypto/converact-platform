import { createHash } from 'node:crypto';

import type { IvrFlowGraph, IvrNodeBase } from './graph-types.js';
import { normalizeGraphForValidation } from './graph-types.js';

export function normalizeIvrGraph(graph: IvrFlowGraph): IvrFlowGraph {
  const normalized = normalizeGraphForValidation(cloneJson(graph));
  return {
    version: normalized.version,
    entryNodeId: normalized.entryNodeId,
    nodes: normalized.nodes
      .map((node) => normalizeNode(node))
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges: normalized.edges
      .map((edge) => ({
        id: String(edge.id ?? ''),
        source: String(edge.source ?? ''),
        target: String(edge.target ?? ''),
        ...(edge.sourceHandle === undefined ? {} : { sourceHandle: String(edge.sourceHandle) }),
        ...(edge.label === undefined ? {} : { label: String(edge.label) })
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    variables: normalized.variables
      .map((variable) => ({
        name: String(variable.name ?? ''),
        ...(variable.defaultValue === undefined ? {} : { defaultValue: String(variable.defaultValue) }),
        ...(variable.description === undefined ? {} : { description: String(variable.description) })
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    ...(normalized.globalShortcuts === undefined ? {} : {
      globalShortcuts: [...normalized.globalShortcuts]
        .map((shortcut) => normalizeJsonValue(shortcut) as typeof shortcut)
        .sort((left, right) => `${left.digit}:${left.action}`.localeCompare(`${right.digit}:${right.action}`))
    })
  };
}

export function canonicalIvrGraphHash(graph: IvrFlowGraph): string {
  return createHash('sha256').update(canonicalJson(normalizeIvrGraph(graph))).digest('hex');
}

export function canonicalIvrPayloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function redactSensitiveIvrGraph(graph: IvrFlowGraph): IvrFlowGraph {
  return sanitizeGraphValue(graph) as IvrFlowGraph;
}

function normalizeNode(node: IvrNodeBase): IvrNodeBase {
  const position = node.position && typeof node.position === 'object'
    ? node.position
    : { x: 0, y: 0 };
  return {
    id: String(node.id ?? ''),
    type: node.type,
    name: String(node.name ?? ''),
    position: {
      x: finiteNumber(position.x, 0),
      y: finiteNumber(position.y, 0)
    },
    data: normalizeJsonValue(node.data) as Record<string, unknown>
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function normalizeJsonValue(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('IVR graph contains a non-finite number');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('IVR graph contains a non-JSON value');
  if (ancestors.has(value)) throw new TypeError('IVR graph contains a circular value');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item, ancestors));
    if (!isPlainObject(value)) throw new TypeError('IVR graph contains a non-plain object');
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = normalizeJsonValue(value[key], ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function sanitizeGraphValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGraphValue);
  if (!isPlainObject(value)) {
    if (typeof value !== 'string') return value;
    return containsSensitiveValue(value) ? '[redacted]' : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeGraphValue(child);
  }
  return output;
}

function containsSensitiveValue(value: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(value)
    || /\b(?:bearer|basic)\s+[A-Za-z0-9+/=_:.-]{4,}/i.test(value)
    || /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:authorization|password|passwd|privatekey|clientsecret|accesstoken|refreshtoken|apikey|bearertoken|credential|secret)$/.test(normalized);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
