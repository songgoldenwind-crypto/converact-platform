import { readFileSync } from 'node:fs';

import { Pool } from 'pg';

import {
  DialogOwnerTakeoverCoordinator
} from './agent-runtime/ivekit/voice/dialog-owner-takeover.js';
import {
  DialogRecoveryCapsuleCodec
} from './agent-runtime/ivekit/voice/dialog-recovery-capsule.js';
import {
  DialogShadowQuorum
} from './agent-runtime/ivekit/voice/dialog-shadow.js';
import {
  JetStreamDialogShadowReplicationBus,
  NatsDialogShadowJetStreamPort
} from './agent-runtime/ivekit/voice/dialog-shadow-jetstream.js';
import {
  DialogShadowJournal
} from './agent-runtime/ivekit/voice/dialog-shadow-journal.js';
import {
  loadDialogShadowAgentConfig
} from './agent-runtime/ivekit/voice/dialog-shadow-runtime.js';
import {
  createDialogShadowHttpServer
} from './agent-runtime/ivekit/voice/dialog-shadow-server.js';
import {
  PostgresDialogOwnerTakeoverStore
} from './agent-runtime/ivekit/voice/postgres/dialog-owner-takeover-store.js';

const config = loadDialogShadowAgentConfig(process.env, readFileSync);
const journal = await DialogShadowJournal.open({
  path: config.journal.path,
  maxRecords: config.journal.max_records,
  maxBytes: config.journal.max_bytes,
  maxRecordBytes: config.journal.max_record_bytes
});
let port: NatsDialogShadowJetStreamPort | null = null;
try {
  port = await NatsDialogShadowJetStreamPort.connect({
    connection_options: config.nats.connection_options,
    ...config.identity,
    journal,
    server_fault_domains: config.nats.server_fault_domains,
    stream_name: config.nats.stream_name,
    subject_prefix: config.nats.subject_prefix,
    stream_replicas: config.nats.stream_replicas,
    max_age_ms: config.nats.max_age_ms,
    placement_cluster: config.nats.placement_cluster,
    placement_tags: config.nats.placement_tags,
    ack_wait_ms: config.nats.ack_wait_ms,
    max_ack_pending: config.nats.max_ack_pending
  });
} catch (error) {
  await journal.close().catch(() => undefined);
  throw error;
}

const replicationBus = new JetStreamDialogShadowReplicationBus({
  port,
  cell_id: config.identity.cell_id,
  origin_node_id: config.identity.node_id,
  subject_prefix: config.nats.subject_prefix,
  ack_timeout_ms: config.nats.quorum_timeout_ms,
  minimum_remote_acks: config.nats.required_fault_domains - 1
});
const shadowCoordinator = new DialogShadowQuorum({
  local_journal: journal,
  replication_bus: replicationBus,
  local_identity: config.identity,
  required_fault_domains: config.nats.required_fault_domains
});
let databaseReady = false;
const database = new Pool({
  connectionString: config.recovery.database_url,
  max: config.recovery.postgres_pool_max,
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 10_000,
  query_timeout: 3_000,
  statement_timeout: 2_000,
  application_name: `ivekit-dialog-recovery-${config.identity.cell_id}`,
  allowExitOnIdle: true
});
database.on('error', () => {
  databaseReady = false;
  process.stderr.write('ivekit dialog recovery database idle client error\n');
});
try {
  await database.query('SELECT 1');
  databaseReady = true;
} catch (error) {
  await database.end().catch(() => undefined);
  await port?.close().catch(() => undefined);
  await journal.close().catch(() => undefined);
  throw error;
}
const takeoverCoordinator = new DialogOwnerTakeoverCoordinator({
  store: new PostgresDialogOwnerTakeoverStore(database),
  shadow_reader: journal,
  recovery_codec: new DialogRecoveryCapsuleCodec({
    current: config.recovery.current_key,
    ...(config.recovery.previous_key
      ? { previous: config.recovery.previous_key }
      : {})
  }),
  token_hmac_keys: {
    current: config.recovery.current_key,
    ...(config.recovery.previous_key
      ? { previous: config.recovery.previous_key }
      : {})
  },
  token_ttl_ms: config.recovery.token_ttl_ms,
  node_lease_ttl_ms: config.recovery.node_lease_ttl_ms
});
const tls = config.server.tls ? {
  key: readFileSync(config.server.tls.key_file),
  cert: readFileSync(config.server.tls.cert_file),
  ca: readFileSync(config.server.tls.ca_file)
} : undefined;
const server = createDialogShadowHttpServer({
  coordinator: shadowCoordinator,
  takeover_coordinator: takeoverCoordinator,
  service_token: config.service_token,
  production: config.production,
  tls,
  spiffe_trust_domain: config.server.spiffe_trust_domain,
  ready: () => port?.isReady() === true && databaseReady,
  max_body_bytes: config.server.max_body_bytes
});

let compacting = false;
const compactTimer = setInterval(() => {
  if (compacting) return;
  compacting = true;
  void journal.compact()
    .catch((error) => {
      process.stderr.write(
        `ivekit dialog shadow compaction failed: ${safeError(error)}\n`
      );
    })
    .finally(() => {
      compacting = false;
    });
}, config.journal.compact_interval_ms);
compactTimer.unref();

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `ivekit dialog shadow agent listening on ${config.host}:${config.port} ` +
    `cell=${config.identity.cell_id} node=${config.identity.node_id} ` +
    `production=${config.production} mtls=${Boolean(tls)}\n`
  );
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearInterval(compactTimer);
  process.stdout.write(`ivekit dialog shadow agent stopping on ${signal}\n`);
  const forced = setTimeout(() => process.exit(1), 10_000);
  forced.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await port?.close().catch((error) => {
    process.stderr.write(
      `ivekit dialog shadow NATS drain failed: ${safeError(error)}\n`
    );
  });
  await database.end().catch(() => {
    process.stderr.write('ivekit dialog recovery database close failed\n');
  });
  await journal.close().catch((error) => {
    process.stderr.write(
      `ivekit dialog shadow journal close failed: ${safeError(error)}\n`
    );
  });
  clearTimeout(forced);
}

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]/g, ' ').slice(0, 512)
    : 'unknown_error';
}
