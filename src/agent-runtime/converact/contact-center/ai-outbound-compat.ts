const MAX_IDENTIFIER_BYTES = 255;
const MAX_LANGUAGE_BYTES = 35;
const MAX_ATTEMPTS = 100;

export interface LegacyOutboundMappingInput {
  tenant_id: string;
  agent_spec_id: string;
  campaign_id: string;
  campaign_contact_id: string;
  language: string;
  max_attempts: number;
  status: 'pending';
}

export interface AttemptLineageInput {
  attempt_id: string;
  attempt_number: number;
  previous_attempt_id: string | null;
}

export interface RustOutboundAttemptProjection {
  tenant_id: string;
  agent_definition_id: string;
  campaign_id: string;
  campaign_contact_id: string;
  call_attempt_id: string;
  previous_attempt_id: string | null;
  attempt_number: number;
  language: string;
  max_attempts: number;
  state: 'planned';
}

/**
 * Maps one legacy pending task into the closed Rust contract projection.
 * This compatibility function does not write state or allocate identities.
 */
export function mapLegacyOutboundTask(
  input: LegacyOutboundMappingInput,
  lineage: AttemptLineageInput,
): RustOutboundAttemptProjection {
  if (
    input.status !== 'pending'
    || !boundedIdentifier(input.tenant_id)
    || !boundedIdentifier(input.agent_spec_id)
    || !boundedIdentifier(input.campaign_id)
    || !boundedIdentifier(input.campaign_contact_id)
    || !boundedIdentifier(lineage.attempt_id)
    || (lineage.previous_attempt_id !== null
      && !boundedIdentifier(lineage.previous_attempt_id))
    || !validLanguage(input.language)
    || !boundedInteger(input.max_attempts, 1, MAX_ATTEMPTS)
    || !boundedInteger(lineage.attempt_number, 1, input.max_attempts)
  ) {
    throw new Error('legacy_outbound_mapping_invalid');
  }

  const isFirstAttempt = lineage.attempt_number === 1;
  if (
    (isFirstAttempt && lineage.previous_attempt_id !== null)
    || (!isFirstAttempt && lineage.previous_attempt_id === null)
    || lineage.previous_attempt_id === lineage.attempt_id
  ) {
    throw new Error('legacy_outbound_attempt_lineage_invalid');
  }

  return {
    tenant_id: input.tenant_id,
    agent_definition_id: input.agent_spec_id,
    campaign_id: input.campaign_id,
    campaign_contact_id: input.campaign_contact_id,
    call_attempt_id: lineage.attempt_id,
    previous_attempt_id: lineage.previous_attempt_id,
    attempt_number: lineage.attempt_number,
    language: input.language,
    max_attempts: input.max_attempts,
    state: 'planned',
  };
}

function boundedIdentifier(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_IDENTIFIER_BYTES
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function validLanguage(value: string): boolean {
  const bytes = Buffer.byteLength(value, 'utf8');
  return bytes >= 2
    && bytes <= MAX_LANGUAGE_BYTES
    && /^[A-Za-z][A-Za-z0-9]{0,7}(?:-[A-Za-z0-9]{1,8})*$/.test(value);
}

function boundedInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
