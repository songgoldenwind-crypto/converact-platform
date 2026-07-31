import { context, propagation } from '@opentelemetry/api';
import { headers, type NatsConnection } from '@nats-io/nats-core';
import {
  connect as connectNode,
  type NodeConnectionOptions
} from '@nats-io/transport-node';

import { resolveNatsConnectionOptions } from './nats-connection-options.js';

export { resolveNatsConnectionOptions } from './nats-connection-options.js';

export interface NatsPublishInput {
  subject: string;
  payload: Record<string, unknown>;
}

interface NatsConnectionLike {
  publish(
    subject: string,
    data: Uint8Array,
    options?: { headers?: ReturnType<typeof headers> }
  ): void;
  drain(): Promise<void>;
  isClosed(): boolean;
}

interface NatsLogger {
  info(message: string): void;
  warn(message: string): void;
}

type NatsConnect = (options: NodeConnectionOptions) => Promise<NatsConnectionLike>;

export class NatsPublisher {
  private connection: NatsConnectionLike | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly connectFn: NatsConnect;
  private readonly logger: NatsLogger;
  private readonly traceHeaders: () => Record<string, string>;

  constructor(input: {
    env?: NodeJS.ProcessEnv;
    connect?: NatsConnect;
    logger?: NatsLogger;
    traceHeaders?: () => Record<string, string>;
  } = {}) {
    this.env = input.env || process.env;
    this.connectFn = input.connect || (connectNode as (options: NodeConnectionOptions) => Promise<NatsConnection>);
    this.logger = input.logger || {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message)
    };
    this.traceHeaders = input.traceHeaders || activeTraceHeaders;
  }

  async connect(): Promise<boolean> {
    const options = resolveNatsConnectionOptions(this.env);
    if (!options) return false;
    if (this.connection && !this.connection.isClosed()) return true;
    this.connection = null;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        this.connection = await this.connectFn(options);
        this.logger.info('[nats] connected');
        return true;
      } catch {
        this.connection = null;
        this.logger.warn('[nats] connection failed');
        return false;
      } finally {
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  async publish(input: NatsPublishInput): Promise<boolean> {
    validPublishSubject(input.subject);
    const encoded = new TextEncoder().encode(JSON.stringify(input.payload));
    const connected = await this.connect();
    if (!connected || !this.connection) return false;
    try {
      const traceHeaders = natsTraceHeaders(this.traceHeaders());
      this.connection.publish(
        input.subject,
        encoded,
        traceHeaders ? { headers: traceHeaders } : undefined
      );
      return true;
    } catch {
      this.connection = null;
      this.logger.warn('[nats] publish failed');
      return false;
    }
  }

  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    if (connection && !connection.isClosed()) await connection.drain();
  }

  isConnected(): boolean {
    return Boolean(this.connection && !this.connection.isClosed());
  }
}

function activeTraceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, {
    set(target, key, value) {
      target[key.toLowerCase()] = value;
    }
  });
  return carrier;
}

function natsTraceHeaders(carrier: Record<string, string>): ReturnType<typeof headers> | null {
  const traceparent = String(carrier.traceparent || '').trim();
  const tracestate = String(carrier.tracestate || '').trim();
  if (!/^00-[a-f0-9]{32}-[a-f0-9]{16}-[a-f0-9]{2}$/.test(traceparent)) return null;
  const result = headers();
  result.set('traceparent', traceparent);
  if (tracestate && tracestate.length <= 512 && !/[\r\n]/.test(tracestate)) {
    result.set('tracestate', tracestate);
  }
  return result;
}

const defaultPublisher = new NatsPublisher();

export function connectNats(): Promise<boolean> {
  return defaultPublisher.connect();
}

export function publishNatsMessage(input: NatsPublishInput): Promise<boolean> {
  return defaultPublisher.publish(input);
}

export function closeNats(): Promise<void> {
  return defaultPublisher.close();
}

export function isNatsConnected(): boolean {
  return defaultPublisher.isConnected();
}

function validPublishSubject(subject: string): void {
  if (
    subject.length === 0 || subject.length > 255 ||
    /[\s\0*>]/.test(subject) || subject.startsWith('.') ||
    subject.endsWith('.') || subject.includes('..')
  ) throw new Error('NATS publish subject is invalid');
}
