import type { PgQueryable } from '../../../db-pg.js';
import { configuredVoiceAddressProtector } from '../voice/address-protector.js';
import { VoiceCallService } from '../voice/call-service.js';
import { VoicePolicyComplianceService } from '../voice/compliance-service.js';
import type { VoiceAddressProtector } from '../voice/ports.js';
import { PostgresVoiceCallUnitOfWork } from '../voice/postgres/unit-of-work.js';
import { ContactCenterOverflowService } from './overflow-service.js';
import { PostgresContactCenterUnitOfWork } from './postgres/unit-of-work.js';
import { IveKitVoiceOverflowAdapter } from './voice-overflow-adapter.js';

export function createPostgresContactCenterOverflowService(
  pg: PgQueryable,
  options: {
    address_protector?: VoiceAddressProtector;
    now?: () => Date;
  } = {}
): ContactCenterOverflowService {
  const voiceUnitOfWork = new PostgresVoiceCallUnitOfWork(pg);
  const calls = new VoiceCallService({
    unit_of_work: voiceUnitOfWork,
    address_protector: options.address_protector ?? configuredVoiceAddressProtector(),
    compliance: new VoicePolicyComplianceService({ unit_of_work: voiceUnitOfWork }),
    event_port: { publish: () => undefined },
    ...(options.now ? { now: options.now } : {})
  });
  return new ContactCenterOverflowService({
    unit_of_work: new PostgresContactCenterUnitOfWork(pg),
    voice: new IveKitVoiceOverflowAdapter({ calls }),
    ...(options.now ? { now: options.now } : {})
  });
}
