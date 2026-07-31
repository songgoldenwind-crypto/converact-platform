import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  validateValkeyCommandInventory
} from '../scripts/lib/valkey-command-inventory.js';

async function inventory(): Promise<unknown> {
  return JSON.parse(
    await readFile('docs/architecture/valkey-command-inventory-v1.json', 'utf8')
  );
}

test('Valkey inventory records only the source-proven OPC command surface', async () => {
  const value = validateValkeyCommandInventory(await inventory());
  const commands = value.command_groups.flatMap((group) => group.commands);

  for (const command of [
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
  ]) {
    assert.ok(commands.includes(command), command);
  }
  for (const unsupported of ['EVAL', 'EVALSHA', 'XADD', 'XREAD', 'CLUSTER SLOTS', 'SELECT']) {
    assert.equal(commands.includes(unsupported), false, unsupported);
  }
  assert.equal(value.constraints.lua, 'not_observed');
  assert.equal(value.constraints.streams, 'not_observed');
  assert.equal(value.constraints.cluster, 'not_approved');
  assert.equal(value.constraints.numbered_databases, 'not_observed');
  assert.equal(
    value.integration_gates.find((gate) => gate.id === 'opc-ivekit-sentinel-failover')?.state,
    'passed_controlled_server'
  );
  assert.equal(
    value.integration_gates.find((gate) => gate.id === 'livekit-shared-redis-runtime')?.state,
    'not_run'
  );
  assert.equal(
    value.integration_gates.find((gate) => gate.id === 'tinode-valkey-consumer')?.state,
    'not_applicable'
  );
});

test('Valkey controlled evidence and migration guide preserve the production boundary', async () => {
  const [value, evidence, migration] = await Promise.all([
    inventory(),
    readFile('docs/evidence/wave2-valkey-sentinel-runtime-2026-07-23.json', 'utf8'),
    readFile('docs/deployment/valkey-sentinel-migration.md', 'utf8')
  ]);
  const validated = validateValkeyCommandInventory(value);
  const gate = validated.integration_gates.find(
    (candidate) => candidate.id === 'opc-ivekit-sentinel-failover'
  );
  assert.ok(gate?.evidence_refs.includes(
    'docs/evidence/wave2-valkey-sentinel-runtime-2026-07-23.json'
  ));

  const parsed = JSON.parse(evidence) as Record<string, unknown>;
  assert.equal(parsed.result, 'passed_controlled_server');
  assert.match(String(parsed.acceptance_source_sha256), /^[a-f0-9]{64}$/);
  assert.equal(parsed.credentials_recorded, false);
  assert.match(migration, /no dual write/i);
  assert.match(migration, /cross-Zone[\s\S]*not_run/);
  assert.match(migration, /LiveKit[\s\S]*not_run/);
  assert.match(migration, /rollback/i);
});

test('Valkey inventory rejects command groups without operational ownership fields', async () => {
  for (const field of ['owner', 'durability_class', 'failover_expectation', 'evidence_state'] as const) {
    const value = await inventory() as {
      command_groups: Array<Record<string, unknown>>;
    };
    delete value.command_groups[0][field];
    assert.throws(
      () => validateValkeyCommandInventory(value),
      new RegExp(`command_groups\\[0\\]\\.${field}`)
    );
  }
});

test('Valkey inventory rejects unapproved scripting, Streams, Cluster and database commands', async () => {
  for (const command of ['EVAL', 'XADD', 'CLUSTER SLOTS', 'SELECT']) {
    const value = await inventory() as {
      command_groups: Array<{ commands: string[] }>;
    };
    value.command_groups[0].commands.push(command);
    assert.throws(
      () => validateValkeyCommandInventory(value),
      /unsupported Valkey command claim/
    );
  }
});
