import { ContactCenterError } from './errors.js';
import type { ContactCenterSupervisorControlPort } from './ports.js';
import type { ContactCenterSupervisorMode } from './types.js';

export class UnsupportedContactCenterSupervisorControl
implements ContactCenterSupervisorControlPort {
  supports(_mode: ContactCenterSupervisorMode): boolean {
    return false;
  }

  async start(): Promise<{ provider_session_id: string }> {
    throw unavailable();
  }

  async end(): Promise<void> {
    throw unavailable();
  }
}

function unavailable(): ContactCenterError {
  return new ContactCenterError({
    code: 'capability_unavailable',
    status: 501,
    details: { capability: 'contact_center.supervisor' }
  });
}
