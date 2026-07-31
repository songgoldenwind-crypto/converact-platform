const ALLOWED_COMMANDS = new Set([
  'AUTH',
  'DEL',
  'EXPIRE',
  'GET',
  'HSET',
  'INFO REPLICATION',
  'PING',
  'PUBLISH',
  'QUIT',
  'ROLE',
  'SENTINEL CKQUORUM',
  'SENTINEL GET-MASTER-ADDR-BY-NAME',
  'SENTINEL REPLICAS',
  'SENTINEL SENTINELS',
  'SET EX',
  'SET EX NX',
  'SUBSCRIBE'
]);

const REQUIRED_COMMANDS = [
  'GET',
  'SET EX',
  'SET EX NX',
  'DEL',
  'HSET',
  'EXPIRE',
  'PUBLISH',
  'SUBSCRIBE',
  'PING',
  'AUTH',
  'ROLE',
  'SENTINEL GET-MASTER-ADDR-BY-NAME',
  'SENTINEL REPLICAS',
  'SENTINEL SENTINELS',
  'SENTINEL CKQUORUM'
] as const;

export interface ValkeyCommandGroup {
  id: string;
  owner: string;
  clients: string[];
  commands: string[];
  semantics: string;
  durability_class: string;
  failover_expectation: string;
  evidence_state: string;
  source_refs: string[];
  evidence_refs: string[];
}

export interface ValkeyIntegrationGate {
  id: string;
  owner: string;
  scope: string;
  state: string;
  success_criteria: string[];
  evidence_refs: string[];
}

export interface ValkeyCommandInventory {
  schema_version: string;
  inventory_id: string;
  audited_at: string;
  target: {
    implementation: string;
    version_line: string;
    topology: string;
  };
  authority: string;
  status: string;
  constraints: {
    lua: 'not_observed';
    streams: 'not_observed';
    cluster: 'not_approved';
    numbered_databases: 'not_observed';
  };
  command_groups: ValkeyCommandGroup[];
  integration_gates: ValkeyIntegrationGate[];
}

export function validateValkeyCommandInventory(value: unknown): ValkeyCommandInventory {
  if (!isRecord(value)) throw new Error('Valkey command inventory must be an object');
  if (value.schema_version !== '1.0.0') throw new Error('unsupported Valkey inventory schema');
  assertString(value.inventory_id, 'inventory_id');
  assertString(value.authority, 'authority');
  assertString(value.status, 'status');
  if (typeof value.audited_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.audited_at)) {
    throw new Error('audited_at must use YYYY-MM-DD');
  }
  if (!isRecord(value.target)) throw new Error('target must be an object');
  assertString(value.target.implementation, 'target.implementation');
  assertString(value.target.version_line, 'target.version_line');
  assertString(value.target.topology, 'target.topology');
  if (!isRecord(value.constraints)) throw new Error('constraints must be an object');
  for (const [field, expected] of Object.entries({
    lua: 'not_observed',
    streams: 'not_observed',
    cluster: 'not_approved',
    numbered_databases: 'not_observed'
  })) {
    if (value.constraints[field] !== expected) {
      throw new Error(`constraints.${field} must be ${expected}`);
    }
  }
  if (!Array.isArray(value.command_groups) || value.command_groups.length === 0) {
    throw new Error('command_groups are required');
  }
  const groups = value.command_groups.map((group, index) => validateCommandGroup(group, index));
  assertUnique(groups.map((group) => group.id), 'command group');
  const commands = new Set(groups.flatMap((group) => group.commands));
  for (const required of REQUIRED_COMMANDS) {
    if (!commands.has(required)) throw new Error(`required Valkey command missing: ${required}`);
  }
  if (!Array.isArray(value.integration_gates) || value.integration_gates.length === 0) {
    throw new Error('integration_gates are required');
  }
  const gates = value.integration_gates.map((gate, index) => validateGate(gate, index));
  assertUnique(gates.map((gate) => gate.id), 'integration gate');
  for (const required of ['livekit-shared-redis-runtime', 'tinode-valkey-consumer']) {
    if (!gates.some((gate) => gate.id === required)) {
      throw new Error(`required Valkey integration gate missing: ${required}`);
    }
  }
  return value as unknown as ValkeyCommandInventory;
}

function validateCommandGroup(value: unknown, index: number): ValkeyCommandGroup {
  const path = `command_groups[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const field of [
    'id',
    'owner',
    'semantics',
    'durability_class',
    'failover_expectation',
    'evidence_state'
  ]) {
    assertString(value[field], `${path}.${field}`);
  }
  const clients = stringArray(value.clients, `${path}.clients`);
  const commands = stringArray(value.commands, `${path}.commands`);
  const sourceRefs = stringArray(value.source_refs, `${path}.source_refs`);
  const evidenceRefs = stringArray(value.evidence_refs, `${path}.evidence_refs`, true);
  assertUnique(commands, `${path} command`);
  for (const command of commands) {
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(`unsupported Valkey command claim: ${command}`);
    }
  }
  return {
    id: value.id as string,
    owner: value.owner as string,
    clients,
    commands,
    semantics: value.semantics as string,
    durability_class: value.durability_class as string,
    failover_expectation: value.failover_expectation as string,
    evidence_state: value.evidence_state as string,
    source_refs: sourceRefs,
    evidence_refs: evidenceRefs
  };
}

function validateGate(value: unknown, index: number): ValkeyIntegrationGate {
  const path = `integration_gates[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const field of ['id', 'owner', 'scope', 'state']) {
    assertString(value[field], `${path}.${field}`);
  }
  return {
    id: value.id as string,
    owner: value.owner as string,
    scope: value.scope as string,
    state: value.state as string,
    success_criteria: stringArray(value.success_criteria, `${path}.success_criteria`),
    evidence_refs: stringArray(value.evidence_refs, `${path}.evidence_refs`, true)
  };
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} is required`);
}

function stringArray(value: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${path} must be ${allowEmpty ? 'an array' : 'a non-empty array'}`);
  }
  value.forEach((item, index) => assertString(item, `${path}[${index}]`));
  return value as string[];
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`duplicate ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
