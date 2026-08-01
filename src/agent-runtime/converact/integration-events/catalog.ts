export interface ConveractFabricIntegrationEventFamily {
  id: 'chat' | 'file' | 'intelligence' | 'media' | 'notification' | 'provider' | 'remote' | 'voice';
  patterns: readonly string[];
}

export interface ConveractFabricIntegrationEventCatalog {
  schema_version: 1;
  envelope_schema_version: 1;
  webhook_signature_version: 'v1';
  pattern_syntax: 'exact_or_trailing_wildcard';
  compatibility: 'additive';
  max_payload_bytes: number;
  families: readonly ConveractFabricIntegrationEventFamily[];
}

export const CONVERACT_FABRIC_INTEGRATION_EVENT_CATALOG: ConveractFabricIntegrationEventCatalog = {
  schema_version: 1,
  envelope_schema_version: 1,
  webhook_signature_version: 'v1',
  pattern_syntax: 'exact_or_trailing_wildcard',
  compatibility: 'additive',
  max_payload_bytes: 64 * 1024,
  families: [
    { id: 'chat', patterns: ['collaboration.session.*', 'collaboration.participant.*', 'collaboration.message.*'] },
    { id: 'file', patterns: ['collaboration.file.*', 'collaboration.attachment.*'] },
    { id: 'intelligence', patterns: ['collaboration.intelligence.*', 'collaboration.policy.*', 'collaboration.quality_review.*', 'collaboration.translation.*'] },
    { id: 'media', patterns: ['ivekit.media.*'] },
    { id: 'notification', patterns: ['notification.*'] },
    { id: 'provider', patterns: ['collaboration.intelligence.provider.*'] },
    { id: 'remote', patterns: ['remote.*', 'ivekit.rustdesk.*'] },
    { id: 'voice', patterns: ['ivekit.voice.*', 'ivekit.ivr.*', 'ivekit.contact_center.*'] }
  ]
};

const EVENT_NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const EVENT_FAMILY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.\*$/;

export function normalizeConveractFabricEventPatterns(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new Error('event patterns must contain between 1 and 64 entries');
  }
  const patterns = input.map((value) => String(value || '').trim());
  if (patterns.some((value) => value.length > 255 || (!EVENT_NAME.test(value) && !EVENT_FAMILY.test(value)))) {
    throw new Error('event pattern must be an exact event name or trailing family wildcard');
  }
  return [...new Set(patterns)].sort();
}

export function matchesConveractFabricEventPattern(eventType: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern.endsWith('.*')
    ? eventType.startsWith(pattern.slice(0, -1))
    : eventType === pattern);
}
