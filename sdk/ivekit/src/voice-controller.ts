import type {
  IveKitVoiceHttpClient,
  IveKitVoiceIdempotencyOptions
} from './http-sdk.js';
import type {
  IveKitVoiceCall,
  IveKitVoiceCallActionInput,
  IveKitVoiceCallCommand,
  IveKitVoiceCapabilities,
  IveKitVoiceClearAddress,
  IveKitVoiceCommandKind,
  IveKitVoiceConferenceCreateOptions,
  IveKitVoiceCreateCallResult,
  IveKitVoiceCreateOutboundCallInput,
  IveKitVoiceExtensionSessionPlan
} from './voice-types.js';

export type IveKitVoiceControllerPhase = 'idle' | 'loading' | 'submitting' | 'ready';

export interface IveKitVoiceControllerError {
  message: string;
  status: number | null;
  retryable: boolean;
}

export interface IveKitVoiceControllerState {
  phase: IveKitVoiceControllerPhase;
  call: IveKitVoiceCall | null;
  command: IveKitVoiceCallCommand | null;
  capabilities: IveKitVoiceCapabilities | null;
  extension_session: IveKitVoiceExtensionSessionPlan | null;
  pending_action: IveKitVoiceCommandKind | 'dial' | 'extension_session' | null;
  error: IveKitVoiceControllerError | null;
}

export type IveKitVoiceControllerClient = Pick<IveKitVoiceHttpClient,
  'getCapabilities' | 'createOutboundCall' | 'getCall' | 'enqueueCallAction' |
  'createLiveKitBridge' | 'createExtensionSession'>;

export interface IveKitVoiceControllerInput {
  client: IveKitVoiceControllerClient;
  idempotencyKey?: () => string;
}

export interface IveKitVoiceController {
  getSnapshot(): Readonly<IveKitVoiceControllerState>;
  subscribe(listener: (state: Readonly<IveKitVoiceControllerState>) => void): () => void;
  loadCapabilities(): Promise<IveKitVoiceCapabilities>;
  prepareExtensionSession(extensionId: string): Promise<IveKitVoiceExtensionSessionPlan>;
  selectCall(callId: string): Promise<IveKitVoiceCall>;
  refresh(): Promise<IveKitVoiceCall>;
  dial(input: IveKitVoiceCreateOutboundCallInput): Promise<IveKitVoiceCreateCallResult>;
  answer(): Promise<IveKitVoiceCallCommand>;
  hangup(): Promise<IveKitVoiceCallCommand>;
  sendDtmf(digits: string): Promise<IveKitVoiceCallCommand>;
  hold(): Promise<IveKitVoiceCallCommand>;
  resume(): Promise<IveKitVoiceCallCommand>;
  blindTransfer(target: IveKitVoiceClearAddress): Promise<IveKitVoiceCallCommand>;
  warmTransfer(target: IveKitVoiceClearAddress): Promise<IveKitVoiceCallCommand>;
  conference(conferenceId: string): Promise<IveKitVoiceCallCommand>;
  createConference(conferenceId: string, options?: IveKitVoiceConferenceCreateOptions): Promise<IveKitVoiceCallCommand>;
  addToConference(conferenceId: string): Promise<IveKitVoiceCallCommand>;
  removeFromConference(conferenceId: string): Promise<IveKitVoiceCallCommand>;
  destroyConference(conferenceId: string): Promise<IveKitVoiceCallCommand>;
  park(slot: string): Promise<IveKitVoiceCallCommand>;
  pickup(slot: string): Promise<IveKitVoiceCallCommand>;
  startRecording(): Promise<IveKitVoiceCallCommand>;
  pauseRecording(): Promise<IveKitVoiceCallCommand>;
  resumeRecording(): Promise<IveKitVoiceCallCommand>;
  stopRecording(): Promise<IveKitVoiceCallCommand>;
  createLiveKitBridge(sipTrunkId: string): Promise<IveKitVoiceCallCommand>;
  resetCall(): void;
  dispose(): void;
}

export function createIveKitVoiceController(input: IveKitVoiceControllerInput): IveKitVoiceController {
  return new DefaultIveKitVoiceController(input);
}

class DefaultIveKitVoiceController implements IveKitVoiceController {
  readonly #client: IveKitVoiceControllerClient;
  readonly #idempotencyKey: () => string;
  readonly #listeners = new Set<(state: Readonly<IveKitVoiceControllerState>) => void>();
  readonly #ambiguousKeys = new Map<string, string>();
  #state: IveKitVoiceControllerState = {
    phase: 'idle',
    call: null,
    command: null,
    capabilities: null,
    extension_session: null,
    pending_action: null,
    error: null
  };

  constructor(input: IveKitVoiceControllerInput) {
    if (!input?.client) throw new Error('client is required');
    this.#client = input.client;
    this.#idempotencyKey = input.idempotencyKey ?? defaultIdempotencyKey;
  }

  getSnapshot(): Readonly<IveKitVoiceControllerState> {
    return this.#state;
  }

  subscribe(listener: (state: Readonly<IveKitVoiceControllerState>) => void): () => void {
    if (typeof listener !== 'function') throw new Error('listener is required');
    this.#listeners.add(listener);
    notifyListener(listener, this.#state);
    return () => this.#listeners.delete(listener);
  }

  async loadCapabilities(): Promise<IveKitVoiceCapabilities> {
    return this.#run({
      phase: 'loading',
      request: () => this.#client.getCapabilities(),
      apply: (capabilities) => ({ capabilities })
    });
  }

  async prepareExtensionSession(extensionIdInput: string): Promise<IveKitVoiceExtensionSessionPlan> {
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

  async selectCall(callIdInput: string): Promise<IveKitVoiceCall> {
    const callId = requiredValue(callIdInput, 'callId');
    return this.#run({
      phase: 'loading',
      request: () => this.#client.getCall(callId),
      apply: (call) => ({ call, command: null })
    });
  }

  async refresh(): Promise<IveKitVoiceCall> {
    return this.selectCall(this.#requiredCall().id);
  }

  async dial(body: IveKitVoiceCreateOutboundCallInput): Promise<IveKitVoiceCreateCallResult> {
    const intent = `dial:${stableJson(body)}`;
    return this.#runIdempotent({
      phase: 'submitting',
      pendingAction: 'dial',
      intent,
      request: (options) => this.#client.createOutboundCall(body, options),
      apply: (created) => ({ call: created.call, command: created.command })
    });
  }

  answer(): Promise<IveKitVoiceCallCommand> {
    return this.#action('answer');
  }

  hangup(): Promise<IveKitVoiceCallCommand> {
    return this.#action('hangup');
  }

  sendDtmf(digits: string): Promise<IveKitVoiceCallCommand> {
    return this.#action('dtmf', { digits: requiredValue(digits, 'digits') });
  }

  hold(): Promise<IveKitVoiceCallCommand> {
    return this.#action('hold');
  }

  resume(): Promise<IveKitVoiceCallCommand> {
    return this.#action('resume');
  }

  blindTransfer(target: IveKitVoiceClearAddress): Promise<IveKitVoiceCallCommand> {
    return this.#transfer('blind_transfer', target);
  }

  warmTransfer(target: IveKitVoiceClearAddress): Promise<IveKitVoiceCallCommand> {
    return this.#transfer('warm_transfer', target);
  }

  conference(conferenceId: string): Promise<IveKitVoiceCallCommand> {
    return this.#action('conference', { conference_id: requiredValue(conferenceId, 'conferenceId') });
  }

  createConference(
    conferenceId: string,
    options: IveKitVoiceConferenceCreateOptions = {}
  ): Promise<IveKitVoiceCallCommand> {
    return this.#action('conference', {
      ...options,
      operation: 'create',
      conference_id: requiredValue(conferenceId, 'conferenceId')
    });
  }

  addToConference(conferenceId: string): Promise<IveKitVoiceCallCommand> {
    return this.#conferenceAction('add', conferenceId);
  }

  removeFromConference(conferenceId: string): Promise<IveKitVoiceCallCommand> {
    return this.#conferenceAction('remove', conferenceId);
  }

  destroyConference(conferenceId: string): Promise<IveKitVoiceCallCommand> {
    return this.#conferenceAction('destroy', conferenceId);
  }

  park(slot: string): Promise<IveKitVoiceCallCommand> {
    return this.#action('park', { slot: requiredValue(slot, 'slot') });
  }

  pickup(slot: string): Promise<IveKitVoiceCallCommand> {
    return this.#action('pickup', { slot: requiredValue(slot, 'slot') });
  }

  startRecording(): Promise<IveKitVoiceCallCommand> {
    return this.#action('recording_start');
  }

  pauseRecording(): Promise<IveKitVoiceCallCommand> {
    return this.#action('recording_pause');
  }

  resumeRecording(): Promise<IveKitVoiceCallCommand> {
    return this.#action('recording_resume');
  }

  stopRecording(): Promise<IveKitVoiceCallCommand> {
    return this.#action('recording_stop');
  }

  #conferenceAction(operation: 'add' | 'remove' | 'destroy', conferenceId: string): Promise<IveKitVoiceCallCommand> {
    return this.#action('conference', {
      operation,
      conference_id: requiredValue(conferenceId, 'conferenceId')
    });
  }

  async createLiveKitBridge(sipTrunkIdInput: string): Promise<IveKitVoiceCallCommand> {
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
    kind: Extract<IveKitVoiceCommandKind, 'blind_transfer' | 'warm_transfer'>,
    target: IveKitVoiceClearAddress
  ): Promise<IveKitVoiceCallCommand> {
    if (!target || typeof target !== 'object') throw new Error('target is required');
    return this.#action(kind, { target: transferAddressValue(target) });
  }

  #action(
    kind: Exclude<IveKitVoiceCommandKind, 'originate' | 'livekit_bridge_create'>,
    payload: Record<string, unknown> = {}
  ): Promise<IveKitVoiceCallCommand> {
    const callId = this.#requiredCall().id;
    const body: IveKitVoiceCallActionInput = {
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

  #requiredCall(): IveKitVoiceCall {
    if (!this.#state.call) throw new Error('select or dial a call first');
    return this.#state.call;
  }

  async #runIdempotent<T>(input: {
    phase: IveKitVoiceControllerPhase;
    pendingAction: IveKitVoiceControllerState['pending_action'];
    intent: string;
    request: (options: IveKitVoiceIdempotencyOptions) => Promise<T>;
    apply: (result: T) => Partial<IveKitVoiceControllerState>;
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
    phase: IveKitVoiceControllerPhase;
    pendingAction?: IveKitVoiceControllerState['pending_action'];
    request: () => Promise<T>;
    apply: (result: T) => Partial<IveKitVoiceControllerState>;
    onError?: (error: IveKitVoiceControllerError) => void;
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

  #readyPhase(): IveKitVoiceControllerPhase {
    return this.#state.call || this.#state.capabilities || this.#state.extension_session ? 'ready' : 'idle';
  }

  #setState(patch: Partial<IveKitVoiceControllerState>): void {
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

function controllerError(cause: unknown): IveKitVoiceControllerError {
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

function transferAddressValue(target: IveKitVoiceClearAddress): string {
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
  listener: (state: Readonly<IveKitVoiceControllerState>) => void,
  state: Readonly<IveKitVoiceControllerState>
): void {
  try {
    listener(state);
  } catch {
    // Listener failures must not corrupt call control state.
  }
}
