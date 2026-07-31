import type { AuthContext, AuthRole } from '../../middleware/auth.js';

export type IveKitCapability =
  | 'events.manage'
  | 'notifications.create'
  | 'notifications.force_delivery'
  | 'notifications.manage'
  | 'notifications.inbox.self'
  | 'notifications.inbox.other'
  | 'audit.read'
  | 'audit.export'
  | 'retention.read'
  | 'retention.manage';

const capabilityRoles: Readonly<Record<IveKitCapability, ReadonlySet<AuthRole>>> = {
  'events.manage': roles('owner', 'admin', 'system'),
  'notifications.create': roles('owner', 'admin', 'operator', 'system'),
  'notifications.force_delivery': roles('owner', 'admin', 'system'),
  'notifications.manage': roles('owner', 'admin', 'system'),
  'notifications.inbox.self': roles('owner', 'admin', 'operator', 'viewer', 'system'),
  'notifications.inbox.other': roles('owner', 'admin', 'system'),
  'audit.read': roles('owner', 'admin', 'system'),
  'audit.export': roles('owner', 'admin', 'system'),
  'retention.read': roles('owner', 'admin', 'system'),
  'retention.manage': roles('owner', 'admin', 'system')
};

export function iveKitCapabilityAllowed(
  auth: Pick<AuthContext, 'authenticated' | 'role' | 'tenantId' | 'userId'>,
  capability: IveKitCapability
): boolean {
  return Boolean(auth.tenantId && auth.userId) && capabilityRoles[capability].has(auth.role);
}

function roles(...values: AuthRole[]): ReadonlySet<AuthRole> {
  return new Set(values);
}
