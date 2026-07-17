import { fileURLToPath } from 'node:url';

import { MemoryPg } from '../src/db-pg.js';
import {
  IntelligenceProviderGovernanceStore
} from '../src/agent-runtime/collaboration/intelligence-provider-governance-store.js';
import {
  createIntelligenceProviderRegistry,
  type IntelligenceProviderProfile
} from '../src/agent-runtime/collaboration/intelligence-provider-registry.js';
import {
  executeIntelligenceProviderRoute,
  IntelligenceProviderRouteError,
  type IntelligenceProviderRouteEvent
} from '../src/agent-runtime/collaboration/intelligence-provider-route.js';
import {
  createHttpTranslationProvider,
  type TranslationProvider
} from '../src/agent-runtime/collaboration/translation-provider.js';
import {
  createControlledProviderState,
  handleControlledProviderRequest,
  type ControlledProviderMode,
  type ControlledProviderState
} from './ivekit-controlled-provider.js';

export interface IveKitProviderGovernanceAcceptanceCheck {
  name: string;
  status: 'passed' | 'failed';
  code: string;
}

export interface IveKitProviderGovernanceAcceptanceReport {
  status: 'passed' | 'failed';
  verification_scope: 'controlled_provider_and_in_memory_governance';
  real_vendor_evidence: false;
  checks: IveKitProviderGovernanceAcceptanceCheck[];
}

const TENANT_ID = 'tenant-controlled-governance';
const TRANSLATION_INPUT = {
  tenant_id: TENANT_ID,
  session_id: 'session-controlled',
  message_id: 'message-controlled',
  source_type: 'message' as const,
  source_ref_id: 'message-controlled',
  source_ref: 'ivekit://message/message-controlled',
  text: 'controlled acceptance source',
  source_language: 'auto',
  target_language: 'en-US'
};

export async function runIveKitProviderGovernanceAcceptance(): Promise<IveKitProviderGovernanceAcceptanceReport> {
  const checks: IveKitProviderGovernanceAcceptanceCheck[] = [];
  await runCheck(checks, 'success', checkSuccess);
  await runCheck(checks, 'rate_limited_429', () => checkRetryableProtocol('rate_limited', 'provider_http_429'));
  await runCheck(checks, 'transient_5xx', () => checkRetryableProtocol('transient_failure', 'provider_http_503'));
  await runCheck(checks, 'timeout', () => checkRetryableProtocol('timeout', 'provider_timeout'));
  await runCheck(checks, 'terminal_no_failover', checkTerminalNoFailover);
  await runCheck(checks, 'quota', checkQuota);

  const circuit = circuitScenario();
  await runCheck(checks, 'circuit_open', circuit.open);
  await runCheck(checks, 'half_open_recovery', circuit.recover);
  await runCheck(checks, 'failover', checkFailoverEvent);

  return {
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'failed',
    verification_scope: 'controlled_provider_and_in_memory_governance',
    real_vendor_evidence: false,
    checks
  };
}

async function checkSuccess(): Promise<void> {
  const scenario = routeScenario('success', 'success');
  const result = await executeIntelligenceProviderRoute({
    tenant_id: TENANT_ID,
    capability: 'translation',
    candidates: scenario.candidates.slice(0, 1),
    governance: scenario.governance,
    invoke: (provider) => provider.translate(TRANSLATION_INPUT)
  });
  required(result.selected_profile.id === 'translation-primary');
  required(result.output.translated_text.startsWith('[en-US]'));
}

async function checkRetryableProtocol(mode: ControlledProviderMode, expectedCode: string): Promise<void> {
  const scenario = routeScenario(mode, 'success');
  const result = await executeIntelligenceProviderRoute({
    tenant_id: TENANT_ID,
    capability: 'translation',
    candidates: scenario.candidates,
    governance: scenario.governance,
    invoke: (provider) => provider.translate(TRANSLATION_INPUT)
  });
  required(result.selected_profile.id === 'translation-fallback');
  required(result.attempts[0]?.code === expectedCode);
  required(result.failed_over);
}

async function checkTerminalNoFailover(): Promise<void> {
  const scenario = routeScenario('terminal_failure', 'success');
  let code = '';
  try {
    await executeIntelligenceProviderRoute({
      tenant_id: TENANT_ID,
      capability: 'translation',
      candidates: scenario.candidates,
      governance: scenario.governance,
      invoke: (provider) => provider.translate(TRANSLATION_INPUT)
    });
  } catch (error) {
    code = String((error as { code?: unknown }).code || '');
  }
  required(code === 'provider_http_422');
  required(scenario.fallbackState.requestCount === 0);
}

async function checkQuota(): Promise<void> {
  const scenario = routeScenario('success', 'success', { requests_per_minute: 1 });
  const input = {
    tenant_id: TENANT_ID,
    capability: 'translation' as const,
    candidates: scenario.candidates.slice(0, 1),
    governance: scenario.governance,
    invoke: (provider: TranslationProvider) => provider.translate(TRANSLATION_INPUT)
  };
  await executeIntelligenceProviderRoute(input);
  const error = await routeError(() => executeIntelligenceProviderRoute(input));
  required(error.attempts[0]?.code === 'minute_quota_exhausted');
}

function circuitScenario(): { open(): Promise<void>; recover(): Promise<void> } {
  let now = new Date('2026-07-15T04:00:00.000Z');
  const scenario = routeScenario('transient_failure', 'success', {
    failure_threshold: 1,
    open_cooldown_ms: 1_000
  }, () => now);
  const input = () => ({
    tenant_id: TENANT_ID,
    capability: 'translation' as const,
    candidates: scenario.candidates.slice(0, 1),
    governance: scenario.governance,
    invoke: (provider: TranslationProvider) => provider.translate(TRANSLATION_INPUT)
  });
  return {
    async open() {
      await routeError(() => executeIntelligenceProviderRoute(input()));
      const runtime = await scenario.governance.listRuntime(TENANT_ID);
      required(runtime[0]?.circuit_state === 'open');
      const denied = await routeError(() => executeIntelligenceProviderRoute(input()));
      required(denied.attempts[0]?.code === 'circuit_open');
    },
    async recover() {
      now = new Date('2026-07-15T04:00:01.001Z');
      scenario.primaryState.mode = 'success';
      const result = await executeIntelligenceProviderRoute(input());
      required(result.selected_profile.id === 'translation-primary');
      const runtime = await scenario.governance.listRuntime(TENANT_ID);
      required(runtime[0]?.circuit_state === 'closed');
      required(runtime[0]?.consecutive_retryable_failures === 0);
    }
  };
}

async function checkFailoverEvent(): Promise<void> {
  const scenario = routeScenario('transient_failure', 'success');
  const events: IntelligenceProviderRouteEvent[] = [];
  const result = await executeIntelligenceProviderRoute({
    tenant_id: TENANT_ID,
    capability: 'translation',
    candidates: scenario.candidates,
    governance: scenario.governance,
    onEvent: (event) => {
      events.push(event);
    },
    invoke: (provider) => provider.translate(TRANSLATION_INPUT)
  });
  required(result.failed_over);
  required(events.some((event) => event.type === 'collaboration.intelligence.provider.failed_over'));
}

function routeScenario(
  primaryMode: ControlledProviderMode,
  fallbackMode: ControlledProviderMode,
  profileOverrides: Record<string, unknown> = {},
  now?: () => Date
) {
  const registry = createIntelligenceProviderRegistry({
    OPC_IVEKIT_PROVIDER_PROFILES_JSON: JSON.stringify([
      profile('translation-primary', 'self_hosted', profileOverrides),
      profile('translation-fallback', 'third_party', profileOverrides)
    ])
  });
  const primaryState = createControlledProviderState({
    mode: primaryMode,
    token: 'controlled-provider-token'
  });
  const fallbackState = createControlledProviderState({
    mode: fallbackMode,
    token: 'controlled-provider-token'
  });
  const fetchImpl = controlledFetch(primaryState, fallbackState);
  const candidates = ['translation-primary', 'translation-fallback'].map((id) => {
    const configured = registry.requireProfile(id, 'translation');
    return {
      profile: configured,
      provider: providerFor(configured, fetchImpl)
    };
  });
  return {
    candidates,
    governance: new IntelligenceProviderGovernanceStore(new MemoryPg(), { now }),
    primaryState,
    fallbackState
  };
}

function profile(
  id: string,
  mode: 'self_hosted' | 'third_party',
  overrides: Record<string, unknown>
): Record<string, unknown> {
  return {
    id,
    capability: 'translation',
    mode,
    base_url: `${mode === 'third_party' ? 'https' : 'http'}://${id}:8080`,
    token_env: 'CONTROLLED_PROVIDER_TOKEN',
    timeout_ms: 1_000,
    reservation_ttl_ms: 6_000,
    ...overrides
  };
}

function providerFor(profileValue: IntelligenceProviderProfile, fetchImpl: typeof fetch): TranslationProvider {
  return createHttpTranslationProvider({
    mode: profileValue.mode,
    baseUrl: profileValue.base_url,
    endpoint: profileValue.endpoint,
    token: 'controlled-provider-token',
    timeoutMs: profileValue.timeout_ms,
    name: profileValue.name,
    profileId: profileValue.id,
    fetch: fetchImpl
  });
}

function controlledFetch(
  primaryState: ControlledProviderState,
  fallbackState: ControlledProviderState
): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const state = url.hostname === 'translation-primary' ? primaryState : fallbackState;
    const response = await handleControlledProviderRequest({
      method: String(init?.method || 'GET'),
      path: url.pathname,
      headers: requestHeaders(init?.headers),
      body: parseBody(init?.body)
    }, state);
    if (response.delay_ms > 0) await waitForDelayOrAbort(response.delay_ms, init?.signal);
    return new Response(response.body, { status: response.status, headers: response.headers });
  };
}

async function waitForDelayOrAbort(delayMs: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function requestHeaders(value: RequestInit['headers']): Record<string, string | undefined> {
  return Object.fromEntries(new Headers(value).entries());
}

function parseBody(value: RequestInit['body']): unknown {
  if (typeof value !== 'string') return {};
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

async function routeError(run: () => Promise<unknown>): Promise<IntelligenceProviderRouteError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof IntelligenceProviderRouteError) return error;
    throw error;
  }
  throw new Error('expected provider route error');
}

async function runCheck(
  checks: IveKitProviderGovernanceAcceptanceCheck[],
  name: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
    checks.push({ name, status: 'passed', code: '' });
  } catch {
    checks.push({ name, status: 'failed', code: 'acceptance_check_failed' });
  }
}

function required(condition: unknown): asserts condition {
  if (!condition) throw new Error('controlled acceptance assertion failed');
}

async function main(): Promise<void> {
  const report = await runIveKitProviderGovernanceAcceptance();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
