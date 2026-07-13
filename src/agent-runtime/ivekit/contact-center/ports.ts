import type {
  ContactCenterAgentPresence,
  ContactCenterAssignment,
  ContactCenterQueue,
  ContactCenterQueueEntry,
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
  updateAssignment(assignment: ContactCenterAssignment, expectedRevision: number): Promise<ContactCenterAssignment>;
  getPresence(tenantId: string, agentId: string, options?: { for_update?: boolean }): Promise<ContactCenterAgentPresence | null>;
  updatePresence(presence: ContactCenterAgentPresence, expectedRevision: number): Promise<ContactCenterAgentPresence>;
  listExpiredOffers(tenantId: string, now: Date, limit: number): Promise<ContactCenterAssignment[]>;
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
