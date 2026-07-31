import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createRemoteGatewaySmokeConfigFromEnv,
  runRemoteGatewaySmoke,
  type RemoteGatewaySmokeConfig,
  type RemoteGatewaySmokeResult
} from './remote-gateway-smoke.js';
import {
  createRustDeskEdgeCommandProcessor,
  createRustDeskEdgeAgentConfigFromEnv,
  runRustDeskEdgeAgentOnce,
  type RustDeskEdgeAgentConfig,
  type RustDeskEdgeAgentResult
} from './rustdesk-edge-agent.js';
import {
  createRustDeskDeploymentPreflightReport,
  type RustDeskDeploymentPreflightReport
} from './rustdesk-deployment-preflight.js';
import { createIveKitRustDeskHttpClient } from '../src/agent-runtime/converact/rustdesk-http-client.js';
import type { RustDeskDisconnectExecutionMethod } from '../src/agent-runtime/collaboration/rustdesk-device-command-store.js';

export interface RustDeskReadinessConfig {
  runEdgeAgent: boolean;
  checkPhysicalDisconnect: boolean;
  edgeAgent?: RustDeskEdgeAgentConfig;
  remoteGateway: RemoteGatewaySmokeConfig;
}

export interface RustDeskReadinessStep {
  name: 'edge-agent' | 'remote-gateway' | 'physical-disconnect';
  ok: boolean;
  durationMs: number;
}

export interface RustDeskPhysicalDisconnectReadinessResult {
  externalId: string;
  commandId: string;
  status: 'succeeded';
  executionMethod: RustDeskDisconnectExecutionMethod;
  edgeInstanceId: string;
  operatorObservedDisconnect: false;
}

export interface RustDeskReadinessResult {
  ok: true;
  steps: RustDeskReadinessStep[];
  preflight?: RustDeskDeploymentPreflightReport;
  edgeAgent?: RustDeskEdgeAgentResult;
  remoteGateway: RemoteGatewaySmokeResult;
  physicalDisconnect?: RustDeskPhysicalDisconnectReadinessResult;
}

export interface RustDeskReadinessFailureReport {
  ok: false;
  error: string;
  preflight?: RustDeskDeploymentPreflightReport;
}

export type RustDeskReadinessReport = RustDeskReadinessResult | RustDeskReadinessFailureReport;

export interface RustDeskReadinessReportWriteResult {
  outputFile: string;
  ok: boolean;
  preflightOk: boolean;
  steps: number;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const edgeDerivedTargetId = '__edge_agent_device__';

export class RustDeskReadinessPreflightError extends Error {
  constructor(readonly preflight: RustDeskDeploymentPreflightReport) {
    super('RustDesk deployment preflight failed');
    this.name = 'RustDeskReadinessPreflightError';
  }
}

export function createRustDeskReadinessConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskReadinessConfig {
  const runEdgeAgent = envFlag(env.OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT);
  const checkPhysicalDisconnect = envFlag(env.OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT);
  const rustdeskControlPlaneBaseUrl = stripTrailingSlash(env.OPC_RUSTDESK_CONTROL_PLANE_BASE_URL || '');
  const remoteGatewayBaseUrl = stripTrailingSlash(env.OPC_REMOTE_GATEWAY_BASE_URL || '');
  const edgeBaseUrl = stripTrailingSlash(
    env.OPC_RUSTDESK_EDGE_BASE_URL ||
    env.OPC_BASE_URL ||
    env.OPC_COLLABORATION_BASE_URL ||
    rustdeskControlPlaneBaseUrl ||
    remoteGatewayBaseUrl ||
    ''
  );
  const normalizedEnv: NodeJS.ProcessEnv = {
    ...env,
    OPC_REMOTE_GATEWAY_PROVIDER: env.OPC_REMOTE_GATEWAY_PROVIDER || 'rustdesk',
    OPC_RUSTDESK_CONTROL_PLANE_BASE_URL: rustdeskControlPlaneBaseUrl,
    OPC_REMOTE_GATEWAY_BASE_URL: remoteGatewayBaseUrl,
    OPC_RUSTDESK_CHECK_DEVICE_ONLINE: readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_DEVICE_ONLINE),
    OPC_RUSTDESK_CHECK_OPERATION_AUDIT: readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_OPERATION_AUDIT),
    OPC_RUSTDESK_CHECK_SERVER_PORTS: readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_SERVER_PORTS),
    OPC_RUSTDESK_REQUIRE_PROTOCOL_URL: readinessFlag(env.OPC_RUSTDESK_READINESS_REQUIRE_PROTOCOL_URL),
    OPC_REMOTE_GATEWAY_CHECK_LAUNCH_URL: readinessFlag(env.OPC_RUSTDESK_READINESS_CHECK_LAUNCH_URL),
    OPC_RUSTDESK_EDGE_BASE_URL: edgeBaseUrl,
    OPC_RUSTDESK_EDGE_API_KEY:
      env.OPC_RUSTDESK_EDGE_API_KEY ||
      env.OPC_COLLABORATION_API_KEY ||
      env.OPC_API_KEY ||
      ''
  };
  if (runEdgeAgent && !normalizedEnv.OPC_REMOTE_GATEWAY_TARGET_ID) {
    normalizedEnv.OPC_REMOTE_GATEWAY_TARGET_ID = edgeDerivedTargetId;
  }

  const remoteGateway = createRemoteGatewaySmokeConfigFromEnv(normalizedEnv);
  if (remoteGateway.provider !== 'rustdesk') {
    throw new Error('rustdesk readiness only supports OPC_REMOTE_GATEWAY_PROVIDER=rustdesk');
  }
  const edgeAgent = runEdgeAgent ? createRustDeskEdgeAgentConfigFromEnv(normalizedEnv) : undefined;
  if (checkPhysicalDisconnect && !edgeAgent) {
    throw new Error(
      'OPC_RUSTDESK_READINESS_CHECK_PHYSICAL_DISCONNECT requires OPC_RUSTDESK_READINESS_RUN_EDGE_AGENT=1'
    );
  }
  if (checkPhysicalDisconnect && !edgeAgent?.disconnectCommandCapable) {
    throw new Error(
      'physical disconnect readiness requires a configured disconnect or restart adapter'
    );
  }

  return {
    runEdgeAgent,
    checkPhysicalDisconnect,
    edgeAgent,
    remoteGateway
  };
}

export async function runRustDeskReadinessFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl: FetchLike = fetch
): Promise<RustDeskReadinessResult> {
  const preflight = createRustDeskDeploymentPreflightReport(env);
  if (!preflight.ok) throw new RustDeskReadinessPreflightError(preflight);
  const result = await runRustDeskReadiness(createRustDeskReadinessConfigFromEnv(env), fetchImpl);
  return {
    ...result,
    preflight
  };
}

export async function runRustDeskReadiness(
  config: RustDeskReadinessConfig,
  fetchImpl: FetchLike = fetch
): Promise<RustDeskReadinessResult> {
  const steps: RustDeskReadinessStep[] = [];
  let edgeAgent: RustDeskEdgeAgentResult | undefined;
  const edgeAgentConfig = config.edgeAgent;
  if (edgeAgentConfig) {
    edgeAgent = await timedStep(steps, 'edge-agent', () => runRustDeskEdgeAgentOnce(edgeAgentConfig, fetchImpl));
  }
  const remoteGatewayConfig = edgeAgent ? withEdgeAgentTarget(config.remoteGateway, edgeAgent) : config.remoteGateway;
  const remoteGateway = await timedStep(steps, 'remote-gateway', () => runRemoteGatewaySmoke(remoteGatewayConfig, fetchImpl));
  const physicalDisconnect = config.checkPhysicalDisconnect
    ? await timedStep(steps, 'physical-disconnect', () =>
      runPhysicalDisconnectReadiness(config, edgeAgent, remoteGateway, fetchImpl))
    : undefined;

  return {
    ok: true,
    steps,
    edgeAgent,
    remoteGateway,
    physicalDisconnect
  };
}

export function writeRustDeskReadinessReport(
  outputFile: string,
  report: RustDeskReadinessReport
): RustDeskReadinessReportWriteResult {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return {
    outputFile,
    ok: report.ok,
    preflightOk: report.preflight?.ok ?? false,
    steps: report.ok ? report.steps.length : 0
  };
}

async function timedStep<T>(
  steps: RustDeskReadinessStep[],
  name: RustDeskReadinessStep['name'],
  run: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  const result = await run();
  steps.push({
    name,
    ok: true,
    durationMs: Date.now() - startedAt
  });
  return result;
}

function withEdgeAgentTarget(
  config: RemoteGatewaySmokeConfig,
  edgeAgent: RustDeskEdgeAgentResult
): RemoteGatewaySmokeConfig {
  return {
    ...config,
    target: {
      ...config.target,
      id: edgeAgent.deviceId
    }
  };
}

async function runPhysicalDisconnectReadiness(
  config: RustDeskReadinessConfig,
  edgeAgent: RustDeskEdgeAgentResult | undefined,
  remoteGateway: RemoteGatewaySmokeResult,
  fetchImpl: FetchLike
): Promise<RustDeskPhysicalDisconnectReadinessResult> {
  const edgeConfig = config.edgeAgent;
  if (!edgeConfig || !edgeAgent) {
    throw new Error('physical disconnect readiness requires a completed edge heartbeat');
  }

  const processor = createRustDeskEdgeCommandProcessor(edgeConfig, fetchImpl);
  let pollResult = await processor.pollOnce(edgeAgent.deviceId);
  for (let attempt = 1; pollResult === 'result_pending' && attempt < 3; attempt += 1) {
    pollResult = await processor.pollOnce(edgeAgent.deviceId);
  }

  const edgeInstanceId = String(edgeConfig.edgeInstanceId || '').trim();
  const client = createIveKitRustDeskHttpClient({
    baseUrl: edgeConfig.baseUrl,
    apiKey: edgeConfig.apiKey,
    tenantId: edgeConfig.tenantId,
    userId: edgeInstanceId,
    fetch: fetchImpl
  });
  const state = await client.getGatewayDisconnectState(remoteGateway.externalId);
  const command = state.command;
  if (state.status !== 'succeeded' || !command) {
    throw new Error(
      `RustDesk physical disconnect readiness requires succeeded command status; got ${state.status}`
    );
  }
  if (command.external_id !== remoteGateway.externalId) {
    throw new Error('RustDesk physical disconnect command external_id does not match the gateway session');
  }
  if (command.device_id !== edgeAgent.deviceId) {
    throw new Error('RustDesk physical disconnect command device_id does not match the ready edge device');
  }
  if (command.execution_method !== 'session_adapter' && command.execution_method !== 'service_restart') {
    throw new Error('RustDesk physical disconnect command is missing a supported execution_method');
  }
  const commandEdgeInstanceId = String(
    command.result_metadata.edge_instance_id || command.claimed_by || ''
  ).trim();
  if (!commandEdgeInstanceId || commandEdgeInstanceId !== edgeInstanceId) {
    throw new Error('RustDesk physical disconnect command edge instance does not match readiness');
  }
  const auditEvents = await client.listGatewayAuditEvents(remoteGateway.externalId);
  for (const eventType of [
    'remote.rustdesk.disconnect.requested',
    'remote.rustdesk.disconnect.claimed',
    'remote.rustdesk.disconnect.succeeded'
  ]) {
    const matching = auditEvents.find((event) =>
      event.external_id === remoteGateway.externalId &&
      event.event_type === eventType &&
      String(event.metadata.command_id || '') === command.id &&
      String(event.metadata.device_id || '') === edgeAgent.deviceId
    );
    if (!matching) {
      throw new Error(
        `RustDesk physical disconnect readiness is missing bound audit event ${eventType}`
      );
    }
  }

  return {
    externalId: remoteGateway.externalId,
    commandId: command.id,
    status: 'succeeded',
    executionMethod: command.execution_method,
    edgeInstanceId: commandEdgeInstanceId,
    operatorObservedDisconnect: false
  };
}

function envFlag(value: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function readinessFlag(value: string | undefined): string {
  return value === undefined ? '1' : value;
}

function stripTrailingSlash(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function main(): Promise<void> {
  const reportFilePath = String(process.env.OPC_RUSTDESK_READINESS_REPORT_FILE || '').trim();
  const result = await runRustDeskReadinessFromEnv(process.env);
  const reportFile = reportFilePath ? writeRustDeskReadinessReport(reportFilePath, result) : undefined;
  console.log(JSON.stringify(reportFile ? { ...result, reportFile } : result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const reportFilePath = String(process.env.OPC_RUSTDESK_READINESS_REPORT_FILE || '').trim();
    if (error instanceof RustDeskReadinessPreflightError) {
      const failure: RustDeskReadinessFailureReport = {
        ok: false,
        error: error.message,
        preflight: error.preflight
      };
      const reportFile = reportFilePath ? writeRustDeskReadinessReport(reportFilePath, failure) : undefined;
      console.error(JSON.stringify(reportFile ? { ...failure, reportFile } : failure, null, 2));
      process.exit(1);
    }
    if (reportFilePath) {
      const failure: RustDeskReadinessFailureReport = {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
      const reportFile = writeRustDeskReadinessReport(reportFilePath, failure);
      console.error(JSON.stringify({ ...failure, reportFile }, null, 2));
      process.exit(1);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
