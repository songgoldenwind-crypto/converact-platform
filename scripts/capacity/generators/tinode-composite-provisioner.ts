import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { canonicalSha256 } from '../canonical-json.js';
import { TinodeWireSession } from './tinode.js';

export interface TinodeCompositeProvisionInput {
  endpoint: string;
  api_key: string;
  output_path: string;
  namespace: string;
  connection_ordinal_start?: number;
  interaction_ordinal_start?: number;
  connection_count: number;
  interaction_count: number;
  agent_topic_capacity: number;
  concurrency: number;
  request_timeout_ms: number;
}

export interface TinodeCompositeProvisionResult {
  schema_version: '1.0.0';
  status: 'provisioned';
  connection_count: number;
  interaction_count: number;
  logical_identity_count: number;
  topic_count: number;
  output_path: string;
  bundle_sha256: string;
}

interface ProvisionedAccount {
  user: string;
  token: string;
}

interface ProvisionedTopic {
  ordinal: number;
  topic: string;
  publisherConnectionOrdinal: number;
  subscriberConnectionOrdinal: number;
}

export async function provisionTinodeCompositeBundle(
  raw: TinodeCompositeProvisionInput
): Promise<TinodeCompositeProvisionResult> {
  const input = validateInput(raw);
  const connectionStart = input.connection_ordinal_start ?? 0;
  const interactionStart = input.interaction_ordinal_start ?? 0;
  const agentCount = Math.ceil(input.interaction_count / input.agent_topic_capacity);
  const logicalIdentityCount = input.interaction_count + agentCount;
  if (logicalIdentityCount > input.connection_count) {
    throw new Error('Tinode composite topology has more logical identities than connections');
  }
  const extraDeviceCount = input.connection_count - logicalIdentityCount;
  if (extraDeviceCount > agentCount) {
    throw new Error('Tinode composite topology allows at most one extra device per agent identity');
  }
  if (existsSync(input.output_path)) {
    throw new Error('Tinode composite credential output already exists');
  }

  const accounts = await mapConcurrent(
    range(0, logicalIdentityCount),
    input.concurrency,
    (ordinal) => createAccount(input, ordinal)
  );
  const topics = await mapConcurrent(
    range(0, input.interaction_count),
    input.concurrency,
    (ordinal) => createTopic(input, ordinal, accounts, agentCount)
  );
  topics.sort((left, right) => left.ordinal - right.ordinal);

  const topicsByAgent = Array.from({ length: agentCount }, () => [] as string[]);
  for (const topic of topics) {
    topicsByAgent[
      topic.subscriberConnectionOrdinal - connectionStart - input.interaction_count
    ].push(topic.topic);
  }
  const connections = [
    ...range(0, input.interaction_count).map((ordinal) => ({
      ordinal: connectionStart + ordinal,
      auth: { scheme: 'token' as const, secret: accounts[ordinal].token },
      topics: [topics[ordinal].topic]
    })),
    ...range(0, agentCount).map((agentOrdinal) => {
      const account = accounts[input.interaction_count + agentOrdinal];
      return {
        ordinal: connectionStart + input.interaction_count + agentOrdinal,
        auth: { scheme: 'token' as const, secret: account.token },
        topics: topicsByAgent[agentOrdinal]
      };
    }),
    ...range(0, extraDeviceCount).map((extraOrdinal) => {
      const agentOrdinal = extraOrdinal % agentCount;
      const account = accounts[input.interaction_count + agentOrdinal];
      return {
        ordinal: connectionStart + logicalIdentityCount + extraOrdinal,
        auth: { scheme: 'token' as const, secret: account.token },
        topics: topicsByAgent[agentOrdinal]
      };
    })
  ];
  const interactions = topics.map((topic) => ({
    ordinal: interactionStart + topic.ordinal,
    topic: topic.topic,
    publisher_connection_ordinal: topic.publisherConnectionOrdinal,
    subscriber_connection_ordinal: topic.subscriberConnectionOrdinal
  }));
  const bundle = {
    schema_version: '1.0.0',
    api_key: input.api_key,
    connections,
    interactions
  };
  writePrivateJsonAtomic(input.output_path, bundle);
  return {
    schema_version: '1.0.0',
    status: 'provisioned',
    connection_count: connections.length,
    interaction_count: interactions.length,
    logical_identity_count: logicalIdentityCount,
    topic_count: topics.length,
    output_path: input.output_path,
    bundle_sha256: fileSha256(input.output_path)
  };
}

async function createAccount(
  input: TinodeCompositeProvisionInput,
  ordinal: number
): Promise<ProvisionedAccount> {
  const globalOrdinal = (input.connection_ordinal_start ?? 0) + ordinal;
  const session = new TinodeWireSession(
    endpointWithApiKey(input.endpoint, input.api_key),
    input.request_timeout_ms
  );
  try {
    await session.open();
    await session.request('hi', {
      ver: '0.22',
      ua: 'iveKit composite capacity provisioner'
    });
    const username = `cap_${canonicalSha256(`${input.namespace}:user:${globalOrdinal}`).slice(0, 22)}`;
    const password = randomBytes(24).toString('base64url');
    const ctrl = await session.request('acc', {
      user: `new${canonicalSha256(`${input.namespace}:account:${globalOrdinal}`).slice(0, 32)}`,
      scheme: 'basic',
      secret: Buffer.from(`${username}:${password}`).toString('base64'),
      login: true,
      tags: [`ivekit-capacity:${input.namespace}`],
      desc: {
        defacs: { auth: 'JRWS', anon: 'N' },
        public: { fn: `iveKit capacity ${globalOrdinal}` },
        private: { source: 'ivekit-capacity', ordinal: globalOrdinal }
      }
    });
    const user = String(ctrl.params?.user || '').trim();
    const token = String(ctrl.params?.token || '').trim();
    if (!user || !token) throw new Error(`Tinode account ${globalOrdinal} has no user or token`);
    await session.closeGracefully();
    return { user, token };
  } catch (error) {
    session.close();
    throw new Error(
      `Tinode account ${globalOrdinal} provisioning failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function createTopic(
  input: TinodeCompositeProvisionInput,
  ordinal: number,
  accounts: readonly ProvisionedAccount[],
  agentCount: number
): Promise<ProvisionedTopic> {
  const connectionStart = input.connection_ordinal_start ?? 0;
  const interactionStart = input.interaction_ordinal_start ?? 0;
  const publisherConnectionOrdinal = ordinal;
  const agentOrdinal = Math.floor(ordinal / input.agent_topic_capacity) % agentCount;
  const subscriberConnectionOrdinal = input.interaction_count + agentOrdinal;
  const publisher = accounts[ordinal];
  const subscriber = accounts[subscriberConnectionOrdinal];
  const session = new TinodeWireSession(
    endpointWithApiKey(input.endpoint, input.api_key),
    input.request_timeout_ms
  );
  try {
    await session.open();
    await session.request('hi', {
      ver: '0.22',
      ua: 'iveKit composite capacity provisioner'
    });
    await session.request('login', { scheme: 'token', secret: publisher.token });
    const ctrl = await session.request('sub', {
      topic: 'new',
      set: {
        desc: {
          public: {
            fn: `iveKit capacity interaction ${ordinal}`,
            'x-ivekit-capacity-namespace': input.namespace,
            'x-ivekit-capacity-ordinal': interactionStart + ordinal
          }
        }
      }
    });
    const topic = String(ctrl.topic || ctrl.params?.topic || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,255}$/.test(topic)) {
      throw new Error(`Tinode topic ${ordinal} has no valid ID`);
    }
    await session.request('set', {
      topic,
      sub: { user: subscriber.user, mode: 'JRP' }
    });
    await session.closeGracefully();
    return {
      ordinal,
      topic,
      publisherConnectionOrdinal: connectionStart + publisherConnectionOrdinal,
      subscriberConnectionOrdinal: connectionStart + subscriberConnectionOrdinal
    };
  } catch (error) {
    session.close();
    throw new Error(
      `Tinode topic ${ordinal} provisioning failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function validateInput(raw: TinodeCompositeProvisionInput): TinodeCompositeProvisionInput {
  const endpoint = new URL(String(raw.endpoint || ''));
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) {
    throw new Error('Tinode composite provision endpoint must use WebSocket');
  }
  if (!raw.api_key || raw.api_key.length > 4_096) {
    throw new Error('Tinode composite provision API key is invalid');
  }
  if (!isAbsolute(String(raw.output_path || ''))) {
    throw new Error('Tinode composite provision output path must be absolute');
  }
  if (!raw.namespace || raw.namespace.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(raw.namespace)) {
    throw new Error('Tinode composite provision namespace is invalid');
  }
  for (const [field, value, minimum, maximum] of [
    ['connection_ordinal_start', raw.connection_ordinal_start ?? 0, 0, Number.MAX_SAFE_INTEGER],
    ['interaction_ordinal_start', raw.interaction_ordinal_start ?? 0, 0, Number.MAX_SAFE_INTEGER],
    ['connection_count', raw.connection_count, 2, 1_000_000],
    ['interaction_count', raw.interaction_count, 1, 1_000_000],
    ['agent_topic_capacity', raw.agent_topic_capacity, 1, 100],
    ['concurrency', raw.concurrency, 1, 10_000],
    ['request_timeout_ms', raw.request_timeout_ms, 250, 60_000]
  ] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      throw new Error(`Tinode composite provision ${field} is invalid`);
    }
  }
  if ((raw.connection_ordinal_start ?? 0) + raw.connection_count > Number.MAX_SAFE_INTEGER ||
      (raw.interaction_ordinal_start ?? 0) + raw.interaction_count > Number.MAX_SAFE_INTEGER) {
    throw new Error('Tinode composite provision ordinal range is invalid');
  }
  return structuredClone(raw);
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  const temporary = join(
    dirname(path),
    `.${canonicalSha256(`${path}:${process.pid}:${Date.now()}:${randomBytes(8).toString('hex')}`)}.tmp`
  );
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function endpointWithApiKey(endpoint: string, apiKey: string): string {
  const url = new URL(endpoint);
  url.searchParams.set('apikey', apiKey);
  return url.toString();
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start }, (_, index) => start + index);
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}
