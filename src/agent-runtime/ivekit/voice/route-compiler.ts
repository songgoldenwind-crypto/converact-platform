import type { RustPbxRouterAdapter, RustPbxRouterResponse } from './adapters/rustpbx-routing.js';
import { VoiceError } from './errors.js';
import type { VoiceCapability } from './types.js';

export type VoiceRouteDependency = 'start_ivr' | 'enqueue' | 'bridge_livekit' | 'voicemail';

export function compileRustPbxRouteRules(input: {
  rules: Record<string, unknown>;
  capabilities: Readonly<Record<VoiceCapability, boolean>>;
  router_adapter: RustPbxRouterAdapter;
  available_dependencies?: ReadonlySet<VoiceRouteDependency>;
}): RustPbxRouterResponse {
  return compile(input, input.rules, false);
}

function compile(
  input: {
    capabilities: Readonly<Record<VoiceCapability, boolean>>;
    router_adapter: RustPbxRouterAdapter;
    available_dependencies?: ReadonlySet<VoiceRouteDependency>;
  },
  rules: Record<string, unknown>,
  isFallback: boolean
): RustPbxRouterResponse {
  const action = typeof rules.action === 'string' ? rules.action : '';
  if (isRouteDependency(action) && !input.available_dependencies?.has(action)) {
    if (!isFallback && isRecord(rules.fallback)) return compile(input, rules.fallback, true);
    return dependencyUnavailable();
  }
  try {
    if (action === 'forward_sip') {
      const targets = Array.isArray(rules.targets) ? rules.targets : [rules.target];
      return input.router_adapter.mapDecision({
        action,
        targets: targets as string[],
        strategy: rules.strategy as 'parallel' | 'sequential' | undefined,
        record: rules.record as boolean | undefined,
        timeout: rules.timeout as number | undefined,
        max_ring_time: rules.max_ring_time as number | undefined,
        headers: rules.headers as Record<string, string> | undefined
      }, input.capabilities);
    }
    if (action === 'reject') {
      return input.router_adapter.mapDecision({
        action,
        code: rules.code as number | undefined,
        reason: rules.reason as string | undefined
      }, input.capabilities);
    }
    if (isRouteDependency(action)) {
      return input.router_adapter.mapDecision({
        action,
        target: boundedIdentifier(rules.target),
        timeout: rules.timeout as number | undefined
      }, input.capabilities);
    }
  } catch (error) {
    if (error instanceof VoiceError
      && (error.code === 'capability_unavailable' || error.code === 'validation_failed')) {
      if (!isFallback && isRecord(rules.fallback)) return compile(input, rules.fallback, true);
      return dependencyUnavailable();
    }
    throw error;
  }
  return dependencyUnavailable();
}

function dependencyUnavailable(): RustPbxRouterResponse {
  return { action: 'reject', status: 503, reason: 'route_dependency_unavailable' };
}

function isRouteDependency(value: string): value is VoiceRouteDependency {
  return value === 'start_ivr' || value === 'enqueue'
    || value === 'bridge_livekit' || value === 'voicemail';
}

function boundedIdentifier(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new VoiceError({ code: 'validation_failed', status: 422 });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
