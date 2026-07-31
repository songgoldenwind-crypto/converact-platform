import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { rustDeskGatewayEventValidationError } from '../src/agent-runtime/collaboration/rustdesk-gateway-event.js';

export interface RustDeskAuditCoverageConfig {
  auditFile: string;
  externalId?: string;
  reportFile?: string;
}

export interface RustDeskAuditCoverageInvalidEvent {
  index: number;
  event_type: string;
  reason: string;
}

export interface RustDeskAuditCoverageResult {
  ok: boolean;
  audit_file: string;
  external_id?: string;
  summary: {
    total_events: number;
    matched_events: number;
    required_event_types: number;
    observed_required_event_types: number;
    missing_event_types: number;
    invalid_events: number;
  };
  required_event_types: string[];
  observed_event_types: string[];
  missing_event_types: string[];
  invalid_events: RustDeskAuditCoverageInvalidEvent[];
  coverage: Record<string, {
    event_type: string;
    observed: boolean;
  }>;
}

interface AuditEvent {
  external_id?: string;
  event_type?: string;
  actor_identity?: string;
  target?: string;
  metadata?: unknown;
  occurred_at?: string;
}

const REQUIRED_COVERAGE = [
  ['control_action', 'remote.rustdesk.control_action.performed'],
  ['file_transfer_started', 'remote.rustdesk.file_transfer.started'],
  ['file_transfer_completed', 'remote.rustdesk.file_transfer.completed'],
  ['recording_started', 'remote.rustdesk.recording.started'],
  ['recording_stopped', 'remote.rustdesk.recording.stopped'],
  ['clipboard_synced', 'remote.rustdesk.clipboard.synced'],
  ['session_ended', 'remote.gateway_session.ended']
] as const;

const REQUIRED_EVENT_TYPES = REQUIRED_COVERAGE.map(([, eventType]) => eventType);

export function createRustDeskAuditCoverageConfigFromEnv(env: NodeJS.ProcessEnv): RustDeskAuditCoverageConfig {
  const auditFile = String(env.OPC_RUSTDESK_AUDIT_COVERAGE_FILE || '').trim();
  const externalId = String(env.OPC_RUSTDESK_AUDIT_COVERAGE_EXTERNAL_ID || '').trim();
  const reportFile = String(env.OPC_RUSTDESK_AUDIT_COVERAGE_REPORT_FILE || '').trim();
  if (!auditFile) throw new Error('OPC_RUSTDESK_AUDIT_COVERAGE_FILE is required');
  return {
    auditFile,
    ...(externalId ? { externalId } : {}),
    ...(reportFile ? { reportFile } : {})
  };
}

export function runRustDeskAuditCoverage(config: RustDeskAuditCoverageConfig): RustDeskAuditCoverageResult {
  const events = loadAuditEvents(config.auditFile);
  const matched = events
    .map((event, index) => ({ event, index: index + 1 }))
    .filter(({ event }) => eventBelongsToExternalId(event, config.externalId));
  const observed = new Set(matched.map(({ event }) => String(event.event_type || '').trim()).filter(Boolean));
  const invalidEvents = matched.flatMap(({ event, index }) => validateAuditEvent(event, index));
  const missingEventTypes = REQUIRED_EVENT_TYPES.filter((eventType) => !observed.has(eventType));
  const coverage = Object.fromEntries(REQUIRED_COVERAGE.map(([key, eventType]) => [
    key,
    { event_type: eventType, observed: observed.has(eventType) }
  ]));
  const result: RustDeskAuditCoverageResult = {
    ok: missingEventTypes.length === 0 && invalidEvents.length === 0,
    audit_file: config.auditFile,
    ...(config.externalId ? { external_id: config.externalId } : {}),
    summary: {
      total_events: events.length,
      matched_events: matched.length,
      required_event_types: REQUIRED_EVENT_TYPES.length,
      observed_required_event_types: REQUIRED_EVENT_TYPES.length - missingEventTypes.length,
      missing_event_types: missingEventTypes.length,
      invalid_events: invalidEvents.length
    },
    required_event_types: REQUIRED_EVENT_TYPES,
    observed_event_types: [...observed].sort(),
    missing_event_types: missingEventTypes,
    invalid_events: invalidEvents,
    coverage
  };

  if (config.reportFile) {
    writeFileSync(config.reportFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  }
  return result;
}

function validateAuditEvent(event: AuditEvent, index: number): RustDeskAuditCoverageInvalidEvent[] {
  const eventType = String(event.event_type || '').trim();
  const invalid: RustDeskAuditCoverageInvalidEvent[] = [];
  if (!eventType) {
    invalid.push({ index, event_type: '', reason: 'event_type is required' });
  }
  if (!String(event.actor_identity || '').trim()) {
    invalid.push({ index, event_type: eventType, reason: 'actor_identity is required' });
  }
  if (!isIsoTimestamp(event.occurred_at)) {
    invalid.push({ index, event_type: eventType, reason: 'occurred_at must be an ISO timestamp' });
  }
  const metadata = metadataObject(event.metadata);
  if (!metadata) {
    invalid.push({ index, event_type: eventType, reason: 'metadata must be a JSON object' });
    return invalid;
  }
  const metadataError = rustDeskGatewayEventValidationError(eventType, metadata);
  if (metadataError) {
    invalid.push({ index, event_type: eventType, reason: metadataError });
  }
  return invalid;
}

function loadAuditEvents(file: string): AuditEvent[] {
  const text = readFileSync(file, 'utf8').trim();
  if (!text) return [];
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return decodeAuditEvents(JSON.parse(text));
    } catch {
      return decodeJsonLines(text);
    }
  }
  return decodeJsonLines(text);
}

function decodeJsonLines(text: string): AuditEvent[] {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => decodeAuditEvents(JSON.parse(line)));
}

function decodeAuditEvents(value: unknown): AuditEvent[] {
  if (Array.isArray(value)) return value.flatMap(decodeAuditEvents);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.events)) return record.events.flatMap(decodeAuditEvents);
  if (record.data && typeof record.data === 'object' && Array.isArray((record.data as Record<string, unknown>).events)) {
    return ((record.data as Record<string, unknown>).events as unknown[]).flatMap(decodeAuditEvents);
  }
  if (Array.isArray(record.audit_events)) return record.audit_events.flatMap(decodeAuditEvents);
  if (record.event && typeof record.event === 'object') return decodeAuditEvents(record.event);
  return [record as AuditEvent];
}

function eventBelongsToExternalId(event: AuditEvent, externalId: string | undefined): boolean {
  if (!externalId) return true;
  return String(event.external_id || '').trim() === externalId;
}

function metadataObject(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isIsoTimestamp(value: unknown): boolean {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) && /^\d{4}-\d{2}-\d{2}T/.test(raw);
}

async function main(): Promise<void> {
  const result = runRustDeskAuditCoverage(createRustDeskAuditCoverageConfigFromEnv(process.env));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
