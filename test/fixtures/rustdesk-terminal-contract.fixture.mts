import type { RustDeskOperationEvidence } from '../../sdk/ivekit/src/types.js';

const reference = {
  type: 'operator_report',
  ref: 'evidence://run-1/control-1',
  sha256: 'a'.repeat(64)
};

const notObserved: RustDeskOperationEvidence = {
  operation_id: 'operation-1',
  operation: 'view_screen',
  status: 'not_observed',
  observer: 'none',
  observed_at: null,
  evidence_refs: [],
  metadata: {}
};

const observed: RustDeskOperationEvidence = {
  operation_id: 'operation-2',
  operation: 'transfer_file',
  status: 'observed_succeeded',
  observer: 'qa',
  observed_at: '2026-07-12T12:00:00.000Z',
  evidence_refs: [reference],
  metadata: {
    operation_id: 'operation-2',
    external_id: 'rdgw_1',
    provider_operation_id: 'transfer-1',
    provider_session_id: 'native-session-1',
    direction: 'upload',
    display_id: 'display-1',
    byte_count: 2048,
    checksum_sha256: 'b'.repeat(64),
    duration_ms: 1200,
    reason: 'operator_verified',
    status_detail: 'checksum_matched'
  }
};

// @ts-expect-error not_observed evidence cannot name a real observer
const invalidNotObservedObserver: RustDeskOperationEvidence = { ...notObserved, observer: 'qa' };

// @ts-expect-error not_observed evidence cannot have an observation timestamp
const invalidNotObservedTimestamp: RustDeskOperationEvidence = { ...notObserved, observed_at: '2026-07-12T12:00:00.000Z' };

// @ts-expect-error not_observed evidence cannot carry evidence references
const invalidNotObservedReference: RustDeskOperationEvidence = { ...notObserved, evidence_refs: [reference] };

// @ts-expect-error observed evidence requires a non-none observer
const invalidObservedObserver: RustDeskOperationEvidence = { ...observed, observer: 'none' };

// @ts-expect-error observed evidence requires a timestamp
const invalidObservedTimestamp: RustDeskOperationEvidence = { ...observed, observed_at: null };

// @ts-expect-error observed evidence requires at least one evidence reference
const invalidObservedReferences: RustDeskOperationEvidence = { ...observed, evidence_refs: [] };

const invalidMetadata: RustDeskOperationEvidence = {
  ...observed,
  metadata: {
    // @ts-expect-error operation evidence metadata rejects content and arbitrary keys
    clipboard_text: 'sensitive clipboard content'
  }
};

void [notObserved, observed, invalidNotObservedObserver, invalidNotObservedTimestamp,
  invalidNotObservedReference, invalidObservedObserver, invalidObservedTimestamp,
  invalidObservedReferences, invalidMetadata];
