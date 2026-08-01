import type {
  ConveractFabricVoiceHttpClient,
  ConveractFabricVoiceIdempotencyOptions
} from './http-sdk.js';
import type {
  ConveractFabricVoiceCall,
  ConveractFabricVoiceCallActionInput,
  ConveractFabricVoiceCallCommand,
  ConveractFabricVoiceCapabilities,
  ConveractFabricVoiceClearAddress,
  ConveractFabricVoiceCommandKind,
  ConveractFabricVoiceConferenceCreateOptions,
  ConveractFabricVoiceCreateCallResult,
  ConveractFabricVoiceCreateOutboundCallInput,
  ConveractFabricVoiceExtensionSessionPlan
} from './voice-types.js';

export type ConveractFabricVoiceControllerPhase = 'idle' | 'loading' | 'submitting' | 'ready';

export interface ConveractFabricVoiceControllerError {
  message: string;
  status: number | null;
  retryable: boolean;
}

export interface ConveractFabricVoiceControllerState {
  phase: ConveractFabricVoiceControllerPhase;
  call: ConveractFabricVoiceCall | null;
  command: ConveractFabricVoiceCallCommand | null;
  capabilities: ConveractFabricVoiceCapabilities | null;
  extension_session: ConveractFabricVoiceExtensionSessionPlan | null;
  pending_action: ConveractFabricVoiceCommandKind | 'dial' | 'extension_session' | null;
  error: ConveractFabricVoiceControllerError | null;
}

export type ConveractFabricVoiceControllerClient = Pick<ConveractFabricVoiceHttpClient,
  'getCapabilities' | 'createOutboundCall' | 'getCall' | 'enqueueCallAction' |
  'createLiveKitBridge' | 'createExtensionSession'>;

export interface ConveractFabricVoiceControllerInput {
  client: ConveractFabricVoiceControllerClient;
  idempotencyKey?: () => string;
}

export interface ConveractFabricVoiceController {
  getSnapshot(): Readonly<ConveractFabricVoiceControllerState>;
  subscribe(listener: (state: Readonly<ConveractFabricVoiceControllerState>) => void): () => void;
  loadCapabilities(): Promise<ConveractFabricVoiceCapabilities>;
  prepareExtensionSession(extensionId: string): Promise<ConveractFabricVoiceExtensionSessionPlan>;
  selectCall(callId: string): Promise<ConveractFabricVoiceCall>;
  refresh(): Promise<ConveractFabricVoiceCall>;
  dial(input: ConveractFabricVoiceCreateOutboundCallInput): Promise<ConveractFabricVoiceCreateCallResult>;
  answer(): Promise<ConveractFabricVoiceCallCommand>;
  hangup(): Promise<ConveractFabricVoiceCallCommand>;
  sendDtmf(digits: string): Promise<ConveractFabricVoiceCallCommand>;
  hold(): Promise<ConveractFabricVoiceCallCommand>;
  resume(): Promise<ConveractFabricVoiceCallCommand>;
  blindTransfer(target: ConveractFabricVoiceClearAddress): Promise<ConveractFabricVoiceCallCommand>;
  warmTransfer(target: ConveractFabricVoiceClearAddress): Promise<ConveractFabricVoiceCallCommand>;
  conference(conferenceId: string): Promise<ConveractFabricVoiceCallCommand>;
  createConference(conferenceId: string, options?: ConveractFabricVoiceConferenceCreateOptions): Promise<ConveractFabricVoiceCallCommand>;
  addToConference(conferenceId: string): Promise<ConveractFabricVoiceCallCommand>;
  removeFromConference(conferenceId: string): Promise<ConveractFabricVoiceCallCommand>;
  destroyConference(conferenceId: string): Promise<ConveractFabricVoiceCallCommand>;
  park(slot: string): Promise<ConveractFabricVoiceCallCommand>;
  pickup(slot: string): Promise<ConveractFabricVoiceCallCommand>;
  startRecording(): Promise<ConveractFabricVoiceCallCommand>;
  pauseRecording(): Promise<ConveractFabricVoiceCallCommand>;
  resumeRecording(): Promise<ConveractFabricVoiceCallCommand>;
  stopRecording(): Promise<ConveractFabricVoiceCallCommand>;
  createLiveKitBridge(sipTrunkId: string): Promise<ConveractFabricVoiceCallCommand>;
  resetCall(): void;
  dispose(): void;
}

export function createConveractFabricVoiceController(input: ConveractFabricVoiceControllerInput): ConveractFabricVoiceController {
  return new DefaultConveractFabricVoiceController(input);
}

class DefaultConveractFabricVoiceController implements ConveractFabricVoiceController {
  readonly #client: ConveractFabricVoiceControllerClient;
  readonly #idempotencyKey: () => string;
  readonly #listeners = new Set<(state: Readonly<ConveractFabricVoiceControllerState>) => void>();
  readonly #ambiguousKeys = new Map<string, string>();
  #state: ConveractFabricVoiceControllerState = {
    phase: 'idle',
    call: null,
    command: null,
    capabilities: null,
    extension_session: null,
    pending_action: null,
    error: null
  };

  constructor(input: ConveractFabricVoiceControllerInput) {
    if (!input?.client) throw new Error('client is required');
    this.#client = input.client;
    this.#idempotencyKey = input.idempotencyKey ?? defaultIdempotencyKey;
  }

  getSnapshot(): Readonly<ConveractFabricVoiceControllerState> {
    return this.#state;
  }

  subscribe(listener: (state: Readonly<ConveractFabricVoiceControllerState>) => void): () => void {
    if (typeof listener !== 'function') throw new Error('listener is required');
    this.#listeners.add(listener);
    notifyListener(listener, this.#state);
    return () => this.#listeners.delete(listener);
  }

  async loadCapabilities(): Promise<ConveractFabricVoiceCapabilities> {
    return this.#run({
      phase: 'loading',
      request: () => this.#client.getCapabilities(),
      apply: (capabilities) => ({ capabilities })
    });
  }

  async prepareExtensionSession(extensionIdInput: string): Promise<ConveractFabricVoiceExtensionSessionPlan> {
    const extensionId = requiredValue(extensionIdInput, 'extensionId');
    const capabilities = this.#state.capabilities ?? await this.loadCapabilities();
    if (!capabilities.capabilities.extension_sessions) {
      const error = new VoiceControllerOperationError('Voice extension sessions are not available', 501);
      this.#recordError(error);
      throw error;
    }
    const intent = `extension_session:${stableJson(extensionId)}`;
    return this.#runIdempotent({
      phase: 'submitting',
      pendingAction: 'extension_session',
      intent,
      request: (options) => this.#client.createExtensionSession(extensionId, options),
      apply: (extensionSession) => ({ extension_session: extensionSession })
    });
  }

  async selectCall(callIdInput: string): Promise<ConveractFabricVoiceCall> {
    const callId = requiredValue(callIdInput, 'callId');
    return this.#run({
      phase: 'loading',
      request: () => this.#client.getCall(callId),
      apply: (call) => ({ call, command: null })
    });
  }

  async refresh(): Promise<ConveractFabricVoiceCall> {
    return this.selectCall(this.#requiredCall().id);
  }

  async dial(body: ConveractFabricVoiceCreateOutboundCallInput): Promise<ConveractFabricVoiceCreateCallResult> {
    const intent = `dial:${stableJson(body)}`;
    return this.#runIdempotent({
      phase: 'submitting',
      pendingAction: 'dial',
      intent,
      request: (options) => this.#client.createOutboundCall(body, options),
      apply: (created) => ({ call: created.call, command: created.command })
    });
  }

  answer(): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('answer');
  }

  hangup(): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('hangup');
  }

  sendDtmf(digits: string): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('dtmf', { digits: requiredValue(digits, 'digits') });
  }

  hold(): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('hold');
  }

  resume(): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('resume');
  }

  blindTransfer(target: ConveractFabricVoiceClearAddress): Promise<ConveractFabricVoiceCallCommand> {
    return this.#transfer('blind_transfer', target);
  }

  warmTransfer(target: ConveractFabricVoiceClearAddress): Promise<ConveractFabricVoiceCallCommand> {
    return this.#transfer('warm_transfer', target);
  }

  conference(conferenceId: string): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('conference', { conference_id: requiredValue(conferenceId, 'conferenceId') });
  }

  createConference(
    conferenceId: string,
    options: ConveractFabricVoiceConferenceCreateOptions = {}
  ): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('conference', {
      ...options,
      operation: 'create',
      conference_id: requiredValue(conferenceId, 'conferenceId')
    });
  }

  addToConference(conferenceId: string): Promise<ConveractFabricVoiceCallCommand> {
    return this.#conferenceAction('add', conferenceId);
  }

  removeFromConference(conferenceId: string): Promise<ConveractFabricVoiceCallCommand> {
    return this.#conferenceAction('remove', conferenceId);
  }

  destroyConference(conferenceId: string): Promise<ConveractFabricVoiceCallCommand> {
    return this.#conferenceAction('destroy', conferenceId);
  }

  park(slot: string): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('park', { slot: requiredValue(slot, 'slot') });
  }

  pickup(slot: string): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('pickup', { slot: requiredValue(slot, 'slot') });
  }

  startRecording(): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('recording_start');
  }

  pauseRecording(): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('recording_pause');
  }

  resumeRecording(): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('recording_resume');
  }

  stopRecording(): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('recording_stop');
  }

  #conferenceAction(operation: 'add' | 'remove' | 'destroy', conferenceId: string): Promise<ConveractFabricVoiceCallCommand> {
    return this.#action('conference', {
      operation,
      conference_id: requiredValue(conferenceId, 'conferenceId')
    });
  }

  async createLiveKitBridge(sipTrunkIdInput: string): Promise<ConveractFabricVoiceCallCommand> {
    const callId = this.#requiredCall().id;
    const sipTrunkId = requiredValue(sipTrunkIdInput, 'sipTrunkId');
    const body = { sip_trunk_id: sipTrunkId };
    return this.#runIdempotent({
      phase: 'submitting',
      pendingAction: 'livekit_bridge_create',
      intent: `bridge:${callId}:${stableJson(body)}`,
      request: (options) => this.#client.createLiveKitBridge(callId, body, options),
      apply: (command) => ({ command })
    });
  }

  resetCall(): void {
    this.#setState({ call: null, command: null, pending_action: null, error: null, phase: 'idle' });
  }

  dispose(): void {
    this.#listeners.clear();
    this.#ambiguousKeys.clear();
  }

  #transfer(
    kind: Extract<ConveractFabricVoiceCommandKind, 'blind_transfer' | 'warm_transfer'>,
    target: ConveractFabricVoiceClearAddress
  ): Promise<ConveractFabricVoiceCallCommand> {
    if (!target || typeof target !== 'object') throw new Error('target is required');
    return this.#action(kind, { target: transferAddressValue(target) });
  }

  #action(
    kind: Exclude<ConveractFabricVoiceCommandKind, 'originate' | 'livekit_bridge_create'>,
    payload: Record<string, unknown> = {}
  ): Promise<ConveractFabricVoiceCallCommand> {
    const callId = this.#requiredCall().id;
    const body: ConveractFabricVoiceCallActionInput = {
      action: kind,
      ...(Object.keys(payload).length ? { payload } : {})
    };
    return this.#runIdempotent({
      phase: 'submitting',
      pendingAction: kind,
      intent: `action:${callId}:${stableJson(body)}`,
      request: (options) => this.#client.enqueueCallAction(callId, body, options),
      apply: (command) => ({ command })
    });
  }

  #requiredCall(): ConveractFabricVoiceCall {
    if (!this.#state.call) throw new Error('select or dial a call first');
    return this.#state.call;
  }

  async #runIdempotent<T>(input: {
    phase: ConveractFabricVoiceControllerPhase;
    pendingAction: ConveractFabricVoiceControllerState['pending_action'];
    intent: string;
    request: (options: ConveractFabricVoiceIdempotencyOptions) => Promise<T>;
    apply: (result: T) => Partial<ConveractFabricVoiceControllerState>;
  }): Promise<T> {
    const key = this.#ambiguousKeys.get(input.intent) ?? this.#newKey(input.intent);
    return this.#run({
      phase: input.phase,
      pendingAction: input.pendingAction,
      request: () => input.request({ idempotencyKey: key }),
      apply: (result) => {
        this.#ambiguousKeys.delete(input.intent);
        return input.apply(result);
      },
      onError: (error) => {
        if (!error.retryable) this.#ambiguousKeys.delete(input.intent);
      }
    });
  }

  async #run<T>(input: {
    phase: ConveractFabricVoiceControllerPhase;
    pendingAction?: ConveractFabricVoiceControllerState['pending_action'];
    request: () => Promise<T>;
    apply: (result: T) => Partial<ConveractFabricVoiceControllerState>;
    onError?: (error: ConveractFabricVoiceControllerError) => void;
  }): Promise<T> {
    this.#assertIdle();
    this.#setState({
      phase: input.phase,
      pending_action: input.pendingAction ?? null,
      error: null
    });
    try {
      const result = await input.request();
      this.#setState({
        ...input.apply(result),
        phase: 'ready',
        pending_action: null,
        error: null
      });
      return result;
    } catch (cause) {
      const error = controllerError(cause);
      input.onError?.(error);
      this.#setState({
        phase: this.#readyPhase(),
        pending_action: null,
        error
      });
      throw cause;
    }
  }

  #assertIdle(): void {
    if (this.#state.phase === 'loading' || this.#state.phase === 'submitting') {
      throw new Error('Voice controller is busy');
    }
  }

  #newKey(intent: string): string {
    const key = requiredValue(this.#idempotencyKey(), 'idempotencyKey');
    if (this.#ambiguousKeys.size >= 128) {
      const oldest = this.#ambiguousKeys.keys().next().value as string | undefined;
      if (oldest) this.#ambiguousKeys.delete(oldest);
    }
    this.#ambiguousKeys.set(intent, key);
    return key;
  }

  #recordError(cause: unknown): void {
    this.#setState({ error: controllerError(cause), phase: this.#readyPhase(), pending_action: null });
  }

  #readyPhase(): ConveractFabricVoiceControllerPhase {
    return this.#state.call || this.#state.capabilities || this.#state.extension_session ? 'ready' : 'idle';
  }

  #setState(patch: Partial<ConveractFabricVoiceControllerState>): void {
    this.#state = Object.freeze({ ...this.#state, ...patch });
    for (const listener of this.#listeners) notifyListener(listener, this.#state);
  }
}

class VoiceControllerOperationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'VoiceControllerOperationError';
  }
}

function controllerError(cause: unknown): ConveractFabricVoiceControllerError {
  const status = numericStatus(cause);
  return {
    message: cause instanceof Error ? cause.message : String(cause),
    status,
    retryable: status === 0 || status === 408 || status === 425 || status === 429 ||
      (status !== null && status >= 500)
  };
}

function numericStatus(value: unknown): number | null {
  if (!value || typeof value !== 'object' || !('status' in value)) return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

function defaultIdempotencyKey(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('crypto.randomUUID is required');
  return globalThis.crypto.randomUUID();
}

function requiredValue(value: unknown, field: string): string {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function transferAddressValue(target: ConveractFabricVoiceClearAddress): string {
  const value = requiredValue(target.value, 'target.value');
  if (target.kind === 'e164') {
    const normalized = value.replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
      throw new Error('target.value must be a valid E.164 address');
    }
    return normalized;
  }
  if (target.kind === 'extension') {
    if (!/^\d{1,20}$/.test(value)) throw new Error('target.value must be a valid extension');
    return value;
  }
  if (target.kind === 'sip_uri') {
    if (!/^sips?:[^\s@]+@[^\s@]+$/i.test(value)) {
      throw new Error('target.value must be a valid SIP URI');
    }
    return value;
  }
  throw new Error('target.kind is invalid');
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Voice request must be JSON serializable');
  return JSON.stringify(stableValue(JSON.parse(serialized) as unknown, new Set<object>()));
}

function stableValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value !== 'object') throw new Error('Voice request must be JSON serializable');
  if (ancestors.has(value)) throw new Error('Voice request must not contain cycles');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => stableValue(item, ancestors) ?? null);
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const normalized = stableValue((value as Record<string, unknown>)[key], ancestors);
      if (normalized !== undefined) output[key] = normalized;
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function notifyListener(
  listener: (state: Readonly<ConveractFabricVoiceControllerState>) => void,
  state: Readonly<ConveractFabricVoiceControllerState>
): void {
  try {
    listener(state);
  } catch {
    // Listener failures must not corrupt call control state.
  }
}
