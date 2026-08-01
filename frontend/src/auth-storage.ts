export type ConveractAuthStorageKey =
  | 'api_key'
  | 'default_spec_id'
  | 'seat_id'
  | 'tenant_id'
  | 'tenant_name'
  | 'token'
  | 'user_email'
  | 'user_id';

function currentKey(key: ConveractAuthStorageKey): string {
  return `converact_${key}`;
}

function legacyKey(key: ConveractAuthStorageKey): string {
  return `opc_${key}`;
}

export function readAuthStorage(key: ConveractAuthStorageKey): string | null {
  const current = localStorage.getItem(currentKey(key));
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyKey(key));
  if (legacy === null) return null;
  localStorage.setItem(currentKey(key), legacy);
  return legacy;
}

export function writeAuthStorage(key: ConveractAuthStorageKey, value: string): void {
  localStorage.setItem(currentKey(key), value);
  localStorage.removeItem(legacyKey(key));
}

export function removeAuthStorage(key: ConveractAuthStorageKey): void {
  localStorage.removeItem(currentKey(key));
  localStorage.removeItem(legacyKey(key));
}
