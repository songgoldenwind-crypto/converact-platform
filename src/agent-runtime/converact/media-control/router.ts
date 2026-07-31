import type {
  MediaTransportCommand,
  MediaTransportCommandIdentity,
  MediaTransportOrphanCandidate,
  MediaTransportOutcome,
  MediaTransportPort,
  MediaTransportQuery,
  MediaTransportSessionSnapshot
} from './transport.js';

const FAST_PATH_PROFILE = 'g711-relay-v1';
const PROCESSING_PROFILE = 'VOICE-IVR-G711-OPUS-V1';

type TransportKind = 'fast_path' | 'processing';

export class MediaTransportRouterError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MediaTransportRouterError';
  }
}

export class MediaTransportRouter implements MediaTransportPort {
  readonly #fastPath: MediaTransportPort;
  readonly #processing: MediaTransportPort;
  readonly #maxBindings: number;
  readonly #bindings = new Map<string, TransportKind>();

  constructor(input: {
    fast_path: MediaTransportPort;
    processing: MediaTransportPort;
    max_bindings?: number;
  }) {
    this.#fastPath = input.fast_path;
    this.#processing = input.processing;
    this.#maxBindings = boundedInteger(
      input.max_bindings ?? 100_000,
      1,
      10_000_000,
      'max_bindings'
    );
  }

  async execute(command: MediaTransportCommand): Promise<MediaTransportOutcome> {
    let kind = this.#bindings.get(command.media_reservation_id);
    let newlyBound = false;
    if (!kind) {
      kind = command.action === 'offer'
        ? profileTransport(command)
        : sessionTransport(command.transport_session_id);
      if (!kind) {
        return failed(
          command.command_id,
          command.action === 'offer'
            ? 'media_profile_unsupported'
            : 'media_transport_binding_missing',
          command.action !== 'offer'
        );
      }
      if (!this.#bind(command.media_reservation_id, kind)) {
        return failed(
          command.command_id,
          'media_transport_binding_capacity_exhausted',
          true
        );
      }
      newlyBound = true;
    }

    const outcome = await this.#transport(kind).execute(command);
    if (newlyBound && command.action === 'offer' && outcome.state === 'failed') {
      this.#unbind(command.media_reservation_id, kind);
    }
    if (command.action === 'delete' && outcome.state === 'succeeded') {
      this.#unbind(command.media_reservation_id, kind);
    }
    return outcome;
  }

  async queryCommand(
    identity: MediaTransportCommandIdentity
  ): Promise<MediaTransportQuery> {
    const bound = this.#bindings.get(identity.media_reservation_id);
    if (bound) return this.#transport(bound).queryCommand(identity);

    const [fastPath, processing] = await Promise.all([
      this.#fastPath.queryCommand(identity),
      this.#processing.queryCommand(identity)
    ]);
    const found = [
      ...(fastPath.found ? [{ kind: 'fast_path' as const, value: fastPath }] : []),
      ...(processing.found
        ? [{ kind: 'processing' as const, value: processing }]
        : [])
    ];
    if (found.length > 1) throw bindingConflict();
    const match = found[0];
    if (!match) return { found: false };
    this.#requireBinding(identity.media_reservation_id, match.kind);
    return match.value;
  }

  async querySession(input: {
    media_reservation_id: string;
    call_id: string;
  }): Promise<MediaTransportSessionSnapshot | undefined> {
    const bound = this.#bindings.get(input.media_reservation_id);
    if (bound) return this.#transport(bound).querySession(input);

    const [fastPath, processing] = await Promise.all([
      this.#fastPath.querySession(input),
      this.#processing.querySession(input)
    ]);
    if (fastPath && processing) throw bindingConflict();
    if (processing) {
      this.#requireBinding(input.media_reservation_id, 'processing');
      return processing;
    }
    if (fastPath) {
      this.#requireBinding(input.media_reservation_id, 'fast_path');
      return fastPath;
    }
    return undefined;
  }

  async scanOrphanCandidates(input: {
    after: string;
    limit: number;
  }): Promise<{
    items: MediaTransportOrphanCandidate[];
    next_cursor: string;
  }> {
    const limit = boundedInteger(input.limit, 1, 10_000, 'orphan_scan_limit');
    const cursor = decodeCursor(input.after);
    const primary = cursor.next;
    const secondary = primary === 'fast_path' ? 'processing' : 'fast_path';
    const pages: Array<{
      kind: TransportKind;
      page: {
        items: MediaTransportOrphanCandidate[];
        next_cursor: string;
      };
    }> = [];
    const primaryPage = await this.#transport(primary).scanOrphanCandidates({
      after: cursor[primary],
      limit: Math.ceil(limit / 2)
    });
    pages.push({ kind: primary, page: primaryPage });
    const remaining = limit - primaryPage.items.length;
    if (remaining > 0) {
      pages.push({
        kind: secondary,
        page: await this.#transport(secondary).scanOrphanCandidates({
          after: cursor[secondary],
          limit: remaining
        })
      });
    }
    const items: MediaTransportOrphanCandidate[] = [];
    for (const { kind, page } of pages) {
      cursor[kind] = page.next_cursor;
      for (const candidate of page.items) {
        this.#requireBinding(candidate.media_reservation_id, kind);
        items.push(candidate);
      }
    }
    return {
      items,
      next_cursor: encodeCursor({
        ...cursor,
        next: secondary
      })
    };
  }

  releaseSession(transportSessionId: string, reason: string): Promise<void> {
    return transportSessionId.startsWith('processing:')
      ? this.#processing.releaseSession(transportSessionId, reason)
      : this.#fastPath.releaseSession(transportSessionId, reason);
  }

  #transport(kind: TransportKind): MediaTransportPort {
    return kind === 'processing' ? this.#processing : this.#fastPath;
  }

  #bind(reservationId: string, kind: TransportKind): boolean {
    const current = this.#bindings.get(reservationId);
    if (current) {
      if (current !== kind) throw bindingConflict();
      return true;
    }
    if (this.#bindings.size >= this.#maxBindings) return false;
    this.#bindings.set(reservationId, kind);
    return true;
  }

  #requireBinding(reservationId: string, kind: TransportKind): void {
    if (!this.#bind(reservationId, kind)) {
      throw new MediaTransportRouterError(
        'media_transport_binding_capacity_exhausted'
      );
    }
  }

  #unbind(reservationId: string, kind: TransportKind): void {
    if (this.#bindings.get(reservationId) === kind) {
      this.#bindings.delete(reservationId);
    }
  }
}

function profileTransport(command: MediaTransportCommand): TransportKind | undefined {
  const profile = command.payload.media_profile_id;
  if (profile === FAST_PATH_PROFILE) return 'fast_path';
  if (profile === PROCESSING_PROFILE) return 'processing';
  return undefined;
}

function sessionTransport(value: string | undefined): TransportKind | undefined {
  if (!value) return undefined;
  return value.startsWith('processing:') ? 'processing' : 'fast_path';
}

function failed(
  commandId: string,
  errorCode: string,
  retryable: boolean
): MediaTransportOutcome {
  return {
    state: 'failed',
    command_id: commandId,
    error_code: errorCode,
    retryable
  };
}

function bindingConflict(): MediaTransportRouterError {
  return new MediaTransportRouterError('media_transport_binding_conflict');
}

interface RouterCursor {
  fast_path: string;
  processing: string;
  next: TransportKind;
}

function decodeCursor(value: string): RouterCursor {
  if (!value) {
    return { fast_path: '', processing: '', next: 'fast_path' };
  }
  if (value.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new MediaTransportRouterError('media_transport_cursor_invalid');
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8')
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid cursor');
    }
    const cursor = parsed as Record<string, unknown>;
    if (![1, 2].includes(Number(cursor.version))
        || typeof cursor.fast_path !== 'string'
        || cursor.fast_path.length > 512
        || typeof cursor.processing !== 'string'
        || cursor.processing.length > 512
        || (cursor.version === 2 &&
          cursor.next !== 'fast_path' &&
          cursor.next !== 'processing')) {
      throw new Error('invalid cursor');
    }
    return {
      fast_path: cursor.fast_path,
      processing: cursor.processing,
      next: cursor.version === 2
        ? cursor.next as TransportKind
        : 'fast_path'
    };
  } catch (error) {
    throw new MediaTransportRouterError(
      error instanceof MediaTransportRouterError
        ? error.code
        : 'media_transport_cursor_invalid'
    );
  }
}

function encodeCursor(cursor: RouterCursor): string {
  return Buffer.from(JSON.stringify({
    version: 2,
    fast_path: cursor.fast_path,
    processing: cursor.processing,
    next: cursor.next
  })).toString('base64url');
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  field: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new MediaTransportRouterError(`media_transport_${field}_invalid`);
  }
  return value;
}
