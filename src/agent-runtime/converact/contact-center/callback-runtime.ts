import type { PgQueryable } from '../../../db-pg.js';
import { configuredVoiceAddressProtector } from '../voice/address-protector.js';
import { VoiceCallService } from '../voice/call-service.js';
import { VoicePolicyComplianceService } from '../voice/compliance-service.js';
import type { VoiceAddressProtector } from '../voice/ports.js';
import { PostgresVoiceCallStore } from '../voice/postgres/call-store.js';
import { PostgresVoiceCallUnitOfWork } from '../voice/postgres/unit-of-work.js';
import { ContactCenterCallbackService } from './callback-service.js';
import { PostgresContactCenterUnitOfWork } from './postgres/unit-of-work.js';
import { IveKitVoiceCallbackAdapter } from './voice-callback-adapter.js';

export function createPostgresContactCenterCallbackService(
  pg: PgQueryable,
  options: {
    address_protector?: VoiceAddressProtector;
    now?: () => Date;
  } = {}
): ContactCenterCallbackService {
  const addressProtector = options.address_protector ?? configuredVoiceAddressProtector();
  const voiceUnitOfWork = new PostgresVoiceCallUnitOfWork(pg);
  const voiceCalls = new VoiceCallService({
    unit_of_work: voiceUnitOfWork,
    address_protector: addressProtector,
    compliance: new VoicePolicyComplianceService({ unit_of_work: voiceUnitOfWork }),
    event_port: { publish: () => undefined },
    ...(options.now ? { now: options.now } : {})
  });
  return new ContactCenterCallbackService({
    unit_of_work: new PostgresContactCenterUnitOfWork(pg),
    address_protector: addressProtector,
    voice: new IveKitVoiceCallbackAdapter({
      calls: new PostgresVoiceCallStore(pg),
      service: voiceCalls,
      address_protector: addressProtector
    }),
    ...(options.now ? { now: options.now } : {})
  });
}
