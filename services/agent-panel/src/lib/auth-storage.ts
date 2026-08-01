export type AgentAuthStorageKey =
  | 'api_key'
  | 'seat_id'
  | 'tenant_id'
  | 'token'
  | 'user_id';

function currentKey(key: AgentAuthStorageKey): string {
  return `converact_${key}`;
}

function legacyKey(key: AgentAuthStorageKey): string {
  return `opc_${key}`;
}

export function readAgentAuthStorage(key: AgentAuthStorageKey): string | null {
  const current = localStorage.getItem(currentKey(key));
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyKey(key));
  if (legacy === null) return null;
  localStorage.setItem(currentKey(key), legacy);
  return legacy;
}

export function writeAgentAuthStorage(key: AgentAuthStorageKey, value: string): void {
  localStorage.setItem(currentKey(key), value);
  localStorage.removeItem(legacyKey(key));
}
