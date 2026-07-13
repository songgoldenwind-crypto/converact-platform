import type {
  ContactCenterAgentPresence,
  ContactCenterAssignment,
  ContactCenterCallbackListInput,
  ContactCenterCallbackRecord,
  ContactCenterQueue,
  ContactCenterQueueEntry,
  ContactCenterQueueEntryListInput,
  ContactCenterPage,
  ContactCenterRoutingCandidate
} from './types.js';

export interface ContactCenterRepository {
  getQueue(tenantId: string, queueId: string, options?: { for_update?: boolean }): Promise<ContactCenterQueue | null>;
  findEntryByIdempotencyKey(tenantId: string, key: string): Promise<ContactCenterQueueEntry | null>;
  countActiveEntries(tenantId: string, queueId: string): Promise<number>;
  insertEntry(entry: ContactCenterQueueEntry): Promise<ContactCenterQueueEntry>;
  getEntry(tenantId: string, entryId: string, options?: { for_update?: boolean }): Promise<ContactCenterQueueEntry | null>;
  getNextWaitingEntry(tenantId: string, queueId: string): Promise<ContactCenterQueueEntry | null>;
  updateEntry(entry: ContactCenterQueueEntry, expectedRevision: number): Promise<ContactCenterQueueEntry>;
  positionOfEntry(tenantId: string, queueId: string, entryId: string): Promise<number | null>;
  averageHandleSeconds(tenantId: string, queueId: string): Promise<number>;
  listRoutingCandidates(tenantId: string, queueId: string): Promise<ContactCenterRoutingCandidate[]>;
  getRoutingCursor(tenantId: string, queueId: string): Promise<string | null>;
  setRoutingCursor(tenantId: string, queueId: string, agentId: string): Promise<void>;
  nextCapacitySlot(tenantId: string, agentId: string): Promise<number | null>;
  nextAssignmentAttempt(tenantId: string, queueEntryId: string): Promise<number>;
  insertAssignment(assignment: ContactCenterAssignment): Promise<ContactCenterAssignment>;
  findAssignmentByIdempotencyKey(tenantId: string, key: string): Promise<ContactCenterAssignment | null>;
  getAssignment(tenantId: string, assignmentId: string, options?: { for_update?: boolean }): Promise<ContactCenterAssignment | null>;
  getActiveAssignmentForEntry(
    tenantId: string,
    queueEntryId: string,
    options?: { for_update?: boolean }
  ): Promise<ContactCenterAssignment | null>;
  updateAssignment(assignment: ContactCenterAssignment, expectedRevision: number): Promise<ContactCenterAssignment>;
  getPresence(tenantId: string, agentId: string, options?: { for_update?: boolean }): Promise<ContactCenterAgentPresence | null>;
  updatePresence(presence: ContactCenterAgentPresence, expectedRevision: number): Promise<ContactCenterAgentPresence>;
  listExpiredOffers(tenantId: string, now: Date, limit: number): Promise<ContactCenterAssignment[]>;
  listExpiredWaitingEntries(tenantId: string, now: Date, limit: number): Promise<ContactCenterQueueEntry[]>;
  listRoutableQueueIds(tenantId: string, now: Date, limit: number): Promise<string[]>;
  listEntries(input: ContactCenterQueueEntryListInput): Promise<ContactCenterPage<ContactCenterQueueEntry>>;
  listAssignmentsForEntries(tenantId: string, entryIds: string[]): Promise<ContactCenterAssignment[]>;
  findCallbackByIdempotencyKey(tenantId: string, key: string): Promise<ContactCenterCallbackRecord | null>;
  insertCallback(callback: ContactCenterCallbackRecord): Promise<ContactCenterCallbackRecord>;
  getCallback(
    tenantId: string,
    callbackId: string,
    options?: { for_update?: boolean }
  ): Promise<ContactCenterCallbackRecord | null>;
  updateCallback(
    callback: ContactCenterCallbackRecord,
    expectedRevision: number
  ): Promise<ContactCenterCallbackRecord>;
  listCallbacks(
    input: ContactCenterCallbackListInput
  ): Promise<ContactCenterPage<ContactCenterCallbackRecord>>;
  getNextDueCallback(
    tenantId: string,
    now: Date
  ): Promise<ContactCenterCallbackRecord | null>;
  listCallbacksForReconciliation(
    tenantId: string,
    limit: number
  ): Promise<ContactCenterCallbackRecord[]>;
}

export interface ContactCenterAddressProtector {
  protect(
    tenantId: string,
    value: string,
    kind: 'e164' | 'extension' | 'sip_uri'
  ): Promise<{ ciphertext: string; hmac: string; redacted: string }>;
  reveal(
    tenantId: string,
    ciphertext: string,
    kind: 'e164' | 'extension' | 'sip_uri'
  ): Promise<string>;
}

export interface ContactCenterCallbackVoicePort {
  getSourceCall(tenantId: string, callId: string): Promise<{
    id: string;
    tenant_id: string;
    profile_id: string;
    direction: 'inbound' | 'outbound';
    business_ref: { type: string; id: string };
  } | null>;
  createOutbound(input: {
    callback: ContactCenterCallbackRecord;
    clear_target: string;
    attempt: number;
  }): Promise<{ call_id: string }>;
  getCallState(tenantId: string, callId: string): Promise<{
    state: string;
    termination_reason: string;
  } | null>;
}

export interface ContactCenterUnitOfWorkContext {
  repository: ContactCenterRepository;
}

export interface ContactCenterUnitOfWork {
  run<T>(
    tenantId: string,
    operation: (context: ContactCenterUnitOfWorkContext) => Promise<T>
  ): Promise<T>;
}
