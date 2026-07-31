import type { PgQueryable } from '../../../db-pg.js';
import { ComplianceStore } from './compliance-store.js';

export type ConsentType = 'recording' | 'ai_disclosure';
export type ConsentStatus = 'granted' | 'denied' | 'pending';

export class ConsentTracker {
  private readonly store: ComplianceStore;

  constructor(pg: PgQueryable) {
    this.store = new ComplianceStore(pg);
  }

  async recordAiDisclosureGranted(callSessionId: string, tenantId: string): Promise<void> {
    await this.store.recordConsent({
      callSessionId,
      tenantId,
      consentType: 'ai_disclosure',
      status: 'granted'
    });
  }

  async recordRecordingConsent(
    callSessionId: string,
    tenantId: string,
    status: 'granted' | 'denied'
  ): Promise<void> {
    await this.store.recordConsent({
      callSessionId,
      tenantId,
      consentType: 'recording',
      status
    });
  }

  async getRecordingConsent(callSessionId: string, tenantId: string): Promise<ConsentStatus | null> {
    return this.store.getConsentStatus(callSessionId, 'recording', tenantId);
  }

  async getAiDisclosureConsent(callSessionId: string, tenantId: string): Promise<ConsentStatus | null> {
    return this.store.getConsentStatus(callSessionId, 'ai_disclosure', tenantId);
  }

  /**
   * Default recording policy: recording is allowed unless the customer
   * has explicitly denied consent. 'pending' (not yet asked) also allows
   * recording — this is intentional for inbound calls where the disclosure
   * announcement itself is recorded. For outbound calls, the compliance-gate
   * enforces that disclosure must complete before conversation proceeds.
   */
  async shouldRecord(callSessionId: string, tenantId: string): Promise<boolean> {
    const status = await this.getRecordingConsent(callSessionId, tenantId);
    return status !== 'denied';
  }
}
