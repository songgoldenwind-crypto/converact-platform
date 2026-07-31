import { createHash, randomUUID } from 'node:crypto';

import { IvrError } from './errors.js';
import type {
  IvrAudioAsset,
  IvrRegionGroup,
  IvrResource,
  IvrResourceKind,
  IvrResourceRepository,
  IvrResourceUnitOfWork,
  IvrRingGroup,
  IvrSettings,
  IvrTimeGroup
} from './resource-types.js';

export interface IvrResourceServiceOptions {
  unit_of_work: IvrResourceUnitOfWork;
  id?: (kind: string) => string;
  now?: () => Date;
}

interface ResourceActorInput {
  tenant_id: string;
  actor: string;
}

export interface CreateIvrAudioAssetInput extends ResourceActorInput {
  name: string;
  source_kind: IvrAudioAsset['source_kind'];
  object_ref?: string;
  tts_text?: string;
  tts_profile_id?: string;
  variable_name?: string;
  language?: string;
  content_type?: string;
  checksum?: string;
  duration_ms?: number | null;
  visibility?: IvrAudioAsset['visibility'];
  status?: IvrAudioAsset['status'];
  metadata?: Record<string, unknown>;
}

export interface UpdateIvrAudioAssetInput extends ResourceActorInput, Partial<Omit<
  CreateIvrAudioAssetInput,
  keyof ResourceActorInput
>> {
  id: string;
  expected_revision: number;
}

export interface CreateIvrTimeGroupInput extends ResourceActorInput {
  name: string;
  timezone?: string;
  schedule?: Record<string, unknown>;
  holidays?: unknown[];
  status?: IvrTimeGroup['status'];
}

export interface UpdateIvrTimeGroupInput extends ResourceActorInput, Partial<Omit<
  CreateIvrTimeGroupInput,
  keyof ResourceActorInput
>> {
  id: string;
  expected_revision: number;
}

export interface CreateIvrRegionGroupInput extends ResourceActorInput {
  name: string;
  regions?: string[];
  match_mode?: IvrRegionGroup['match_mode'];
  status?: IvrRegionGroup['status'];
}

export interface UpdateIvrRegionGroupInput extends ResourceActorInput, Partial<Omit<
  CreateIvrRegionGroupInput,
  keyof ResourceActorInput
>> {
  id: string;
  expected_revision: number;
}

export interface CreateIvrRingGroupInput extends ResourceActorInput {
  name: string;
  member_identities?: string[];
  strategy?: IvrRingGroup['strategy'];
  ring_timeout_seconds?: number;
  max_rounds?: number;
  status?: IvrRingGroup['status'];
}

export interface UpdateIvrRingGroupInput extends ResourceActorInput, Partial<Omit<
  CreateIvrRingGroupInput,
  keyof ResourceActorInput
>> {
  id: string;
  expected_revision: number;
}

export interface UpdateIvrSettingsInput extends ResourceActorInput, Partial<Pick<IvrSettings,
  'default_language' | 'max_steps' | 'max_subflow_depth' | 'external_action_timeout_ms'
  | 'validation_mode' | 'allowed_webhook_refs' | 'execution_policy'
>> {
  expected_revision: number;
}

const RUNTIME_FIELDS: Record<IvrResourceKind, ReadonlySet<string>> = {
  audio_asset: new Set([
    'source_kind', 'object_ref', 'tts_text', 'tts_profile_id', 'variable_name', 'language',
    'content_type', 'checksum', 'duration_ms', 'visibility', 'status'
  ]),
  time_group: new Set(['timezone', 'schedule', 'holidays', 'status']),
  region_group: new Set(['regions', 'match_mode', 'status']),
  ring_group: new Set([
    'member_identities', 'strategy', 'ring_timeout_seconds', 'max_rounds', 'status'
  ])
};

export class IvrResourceService {
  readonly #unitOfWork: IvrResourceUnitOfWork;
  readonly #id: (kind: string) => string;
  readonly #now: () => Date;

  constructor(options: IvrResourceServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  listAudioAssets(tenantId: string): Promise<IvrAudioAsset[]> {
    return this.#list(identifier(tenantId), 'audio_asset');
  }

  listTimeGroups(tenantId: string): Promise<IvrTimeGroup[]> {
    return this.#list(identifier(tenantId), 'time_group');
  }

  listRegionGroups(tenantId: string): Promise<IvrRegionGroup[]> {
    return this.#list(identifier(tenantId), 'region_group');
  }

  listRingGroups(tenantId: string): Promise<IvrRingGroup[]> {
    return this.#list(identifier(tenantId), 'ring_group');
  }

  getAudioAsset(tenantId: string, id: string): Promise<IvrAudioAsset> {
    return this.#get(identifier(tenantId), 'audio_asset', identifier(id));
  }

  getTimeGroup(tenantId: string, id: string): Promise<IvrTimeGroup> {
    return this.#get(identifier(tenantId), 'time_group', identifier(id));
  }

  getRegionGroup(tenantId: string, id: string): Promise<IvrRegionGroup> {
    return this.#get(identifier(tenantId), 'region_group', identifier(id));
  }

  getRingGroup(tenantId: string, id: string): Promise<IvrRingGroup> {
    return this.#get(identifier(tenantId), 'ring_group', identifier(id));
  }

  async createAudioAsset(input: CreateIvrAudioAssetInput): Promise<IvrAudioAsset> {
    const base = this.#base(input, 'audio_asset');
    return await this.#insert(input.tenant_id, normalizeAudio({
      ...base,
      source_kind: input.source_kind,
      object_ref: input.object_ref ?? '',
      tts_text: input.tts_text ?? '',
      tts_profile_id: input.tts_profile_id ?? '',
      variable_name: input.variable_name ?? '',
      language: input.language ?? 'zh-CN',
      content_type: input.content_type ?? '',
      checksum: input.checksum ?? '',
      duration_ms: input.duration_ms ?? null,
      visibility: input.visibility ?? 'tenant',
      status: input.status ?? 'active',
      metadata: input.metadata ?? {},
      created_by: identifier(input.actor),
      updated_by: identifier(input.actor)
    }));
  }

  async createTimeGroup(input: CreateIvrTimeGroupInput): Promise<IvrTimeGroup> {
    return await this.#insert(input.tenant_id, normalizeTimeGroup({
      ...this.#base(input, 'time_group'),
      timezone: input.timezone ?? 'Asia/Shanghai', schedule: input.schedule ?? {},
      holidays: input.holidays ?? [], status: input.status ?? 'active'
    }));
  }

  async createRegionGroup(input: CreateIvrRegionGroupInput): Promise<IvrRegionGroup> {
    return await this.#insert(input.tenant_id, normalizeRegionGroup({
      ...this.#base(input, 'region_group'),
      regions: input.regions ?? [], match_mode: input.match_mode ?? 'prefix',
      status: input.status ?? 'active'
    }));
  }

  async createRingGroup(input: CreateIvrRingGroupInput): Promise<IvrRingGroup> {
    return await this.#insert(input.tenant_id, normalizeRingGroup({
      ...this.#base(input, 'ring_group'),
      member_identities: input.member_identities ?? [], strategy: input.strategy ?? 'simultaneous',
      ring_timeout_seconds: input.ring_timeout_seconds ?? 20, max_rounds: input.max_rounds ?? 1,
      status: input.status ?? 'active'
    }));
  }

  updateAudioAsset(input: UpdateIvrAudioAssetInput): Promise<IvrAudioAsset> {
    return this.#update(input, 'audio_asset', normalizeAudio);
  }

  updateTimeGroup(input: UpdateIvrTimeGroupInput): Promise<IvrTimeGroup> {
    return this.#update(input, 'time_group', normalizeTimeGroup);
  }

  updateRegionGroup(input: UpdateIvrRegionGroupInput): Promise<IvrRegionGroup> {
    return this.#update(input, 'region_group', normalizeRegionGroup);
  }

  updateRingGroup(input: UpdateIvrRingGroupInput): Promise<IvrRingGroup> {
    return this.#update(input, 'ring_group', normalizeRingGroup);
  }

  async getSettings(tenantIdInput: string): Promise<IvrSettings> {
    const tenantId = identifier(tenantIdInput);
    return this.#unitOfWork.run(tenantId, async ({ resources }) =>
      await resources.getSettings(tenantId) ?? defaultSettings(tenantId, this.#timestamp()));
  }

  async updateSettings(input: UpdateIvrSettingsInput): Promise<IvrSettings> {
    const tenantId = identifier(input.tenant_id);
    const actor = identifier(input.actor);
    const expected = revision(input.expected_revision, true);
    return this.#unitOfWork.run(tenantId, async ({ resources }) => {
      const current = await resources.getSettings(tenantId, { for_update: true });
      if ((current?.revision ?? 0) !== expected) throw conflict();
      const base = current ?? defaultSettings(tenantId, this.#timestamp());
      const next = normalizeSettings({
        ...base,
        ...pickDefined(input as unknown as Record<string, unknown>, [
          'default_language', 'max_steps', 'max_subflow_depth', 'external_action_timeout_ms',
          'validation_mode', 'allowed_webhook_refs', 'execution_policy'
        ]),
        id: base.id,
        tenant_id: tenantId,
        revision: expected + 1,
        updated_by: actor,
        created_at: base.created_at,
        updated_at: this.#timestamp()
      });
      return current
        ? resources.updateSettings(next, expected)
        : resources.insertSettings(next);
    });
  }

  #base<K extends IvrResourceKind>(input: ResourceActorInput & { name: string }, kind: K) {
    const timestamp = this.#timestamp();
    return {
      id: identifier(this.#id(`ivr-${kind}`)),
      tenant_id: identifier(input.tenant_id),
      kind,
      name: displayName(input.name),
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp
    };
  }

  #list<K extends IvrResourceKind>(tenantId: string, kind: K) {
    return this.#unitOfWork.run(tenantId, ({ resources }) => resources.list(tenantId, kind));
  }

  #get<K extends IvrResourceKind>(tenantId: string, kind: K, id: string) {
    return this.#unitOfWork.run(tenantId, async ({ resources }) =>
      required(await resources.get(tenantId, kind, id)));
  }

  #insert<K extends IvrResourceKind>(tenantIdInput: string, resource: Extract<IvrResource, { kind: K }>) {
    const tenantId = identifier(tenantIdInput);
    return this.#unitOfWork.run(tenantId, ({ resources }) => resources.insert(resource));
  }

  async #update<K extends IvrResourceKind>(
    input: ResourceActorInput & { id: string; expected_revision: number },
    kind: K,
    normalize: (resource: Extract<IvrResource, { kind: K }>) => Extract<IvrResource, { kind: K }>
  ): Promise<Extract<IvrResource, { kind: K }>> {
    const tenantId = identifier(input.tenant_id);
    const id = identifier(input.id);
    const expected = revision(input.expected_revision);
    const patch = pickDefined(input as unknown as Record<string, unknown>, [
      'name', 'metadata', ...RUNTIME_FIELDS[kind]
    ]);
    return this.#unitOfWork.run(tenantId, async ({ resources }) => {
      if (hasRuntimeMutation(kind, patch)) await assertNotReferenced(resources, tenantId, kind, id);
      const current = required(await resources.get(tenantId, kind, id, { for_update: true }));
      if (current.revision !== expected) throw conflict();
      const next = normalize({
        ...current,
        ...patch,
        id: current.id,
        tenant_id: current.tenant_id,
        kind: current.kind,
        revision: current.revision + 1,
        created_at: current.created_at,
        updated_at: this.#timestamp(),
        ...('updated_by' in current ? { updated_by: identifier(input.actor) } : {})
      } as Extract<IvrResource, { kind: K }>);
      return resources.update(next, expected);
    });
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new IvrError({ code: 'internal_error', status: 500 });
    }
    return value.toISOString();
  }
}

async function assertNotReferenced(
  resources: IvrResourceRepository,
  tenantId: string,
  kind: IvrResourceKind,
  id: string
): Promise<void> {
  const references = await resources.currentPublishedReferences(tenantId, kind, id);
  if (references.length > 0) {
    throw new IvrError({ code: 'resource_in_use', status: 409, details: { references } });
  }
}

function normalizeAudio(value: IvrAudioAsset): IvrAudioAsset {
  const sourceKind = enumeration(value.source_kind, ['audio_file', 'tts', 'variable'] as const);
  const objectRef = optionalText(value.object_ref, 2048);
  const ttsText = optionalText(value.tts_text, 10_000);
  const variableName = optionalIdentifier(value.variable_name);
  if ((sourceKind === 'audio_file' && (!safeObjectRef(objectRef) || ttsText || variableName))
    || (sourceKind === 'tts' && (!ttsText || objectRef || variableName))
    || (sourceKind === 'variable' && (!variableName || objectRef || ttsText))) invalid();
  return {
    ...value,
    name: displayName(value.name),
    source_kind: sourceKind,
    object_ref: objectRef,
    tts_text: ttsText,
    tts_profile_id: optionalIdentifier(value.tts_profile_id),
    variable_name: variableName,
    language: language(value.language),
    content_type: optionalText(value.content_type, 128),
    checksum: checksum(value.checksum),
    duration_ms: nullableInteger(value.duration_ms, 0, 86_400_000),
    visibility: enumeration(value.visibility, ['tenant', 'flow'] as const),
    status: enumeration(value.status, ['active', 'processing', 'failed', 'archived'] as const),
    metadata: safeRecord(value.metadata),
    created_by: identifier(value.created_by),
    updated_by: identifier(value.updated_by)
  };
}

function normalizeTimeGroup(value: IvrTimeGroup): IvrTimeGroup {
  const timezone = optionalText(value.timezone, 128);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0)); } catch { invalid(); }
  return {
    ...value, name: displayName(value.name), timezone,
    schedule: safeRecord(value.schedule), holidays: safeArray(value.holidays, 366),
    status: enumeration(value.status, ['active', 'disabled', 'archived'] as const)
  };
}

function normalizeRegionGroup(value: IvrRegionGroup): IvrRegionGroup {
  const matchMode = enumeration(value.match_mode, ['prefix', 'exact', 'regex'] as const);
  const regions = uniqueStrings(value.regions, 500, 256);
  if (matchMode === 'regex') {
    for (const region of regions) try { new RegExp(region, 'u'); } catch { invalid(); }
  }
  return {
    ...value, name: displayName(value.name), regions, match_mode: matchMode,
    status: enumeration(value.status, ['active', 'disabled', 'archived'] as const)
  };
}

function normalizeRingGroup(value: IvrRingGroup): IvrRingGroup {
  return {
    ...value, name: displayName(value.name),
    member_identities: uniqueIdentifiers(value.member_identities, 200),
    strategy: enumeration(value.strategy, ['simultaneous', 'sequential', 'least_busy', 'random'] as const),
    ring_timeout_seconds: boundedInteger(value.ring_timeout_seconds, 1, 300),
    max_rounds: boundedInteger(value.max_rounds, 1, 20),
    status: enumeration(value.status, ['active', 'disabled', 'archived'] as const)
  };
}

function normalizeSettings(value: IvrSettings): IvrSettings {
  return {
    ...value,
    default_language: language(value.default_language),
    max_steps: boundedInteger(value.max_steps, 1, 10_000),
    max_subflow_depth: boundedInteger(value.max_subflow_depth, 1, 100),
    external_action_timeout_ms: boundedInteger(value.external_action_timeout_ms, 100, 300_000),
    validation_mode: enumeration(value.validation_mode, ['warn', 'block'] as const),
    allowed_webhook_refs: uniqueIdentifiers(value.allowed_webhook_refs, 500),
    execution_policy: safeRecord(value.execution_policy),
    revision: revision(value.revision),
    updated_by: identifier(value.updated_by)
  };
}

function defaultSettings(tenantId: string, now: string): IvrSettings {
  return {
    id: `ivr-settings-${createHash('sha256').update(tenantId).digest('hex')}`,
    tenant_id: tenantId,
    default_language: 'zh-CN',
    max_steps: 500,
    max_subflow_depth: 10,
    external_action_timeout_ms: 10_000,
    validation_mode: 'block',
    allowed_webhook_refs: [],
    execution_policy: {},
    revision: 0,
    updated_by: 'system',
    created_at: now,
    updated_at: now
  };
}

function hasRuntimeMutation(kind: IvrResourceKind, patch: Record<string, unknown>): boolean {
  return Object.keys(patch).some((key) => RUNTIME_FIELDS[kind].has(key));
}

function pickDefined(input: Record<string, unknown>, allowed: Iterable<string>): Record<string, unknown> {
  const keys = new Set(allowed);
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => keys.has(key) && value !== undefined));
}

function identifier(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const output = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(output)) invalid();
  return output;
}

function optionalIdentifier(value: unknown): string {
  return value === '' || value === undefined || value === null ? '' : identifier(value);
}

function displayName(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const output = value.trim();
  if (!output || output.length > 256 || /[\u0000-\u001f\u007f]/.test(output)) invalid();
  return output;
}

function optionalText(value: unknown, maxBytes: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes || /\u0000/.test(value)) invalid();
  return value.trim();
}

function language(value: unknown): string {
  const output = optionalText(value, 35);
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(output)) invalid();
  return output;
}

function checksum(value: unknown): string {
  const output = optionalText(value, 64).toLowerCase();
  if (output && !/^[a-f0-9]{64}$/.test(output)) invalid();
  return output;
}

function safeObjectRef(value: string): boolean {
  return /^(?:s3|minio|object):\/\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !/authorization|password|private[_-]?key|access[_-]?token|secret/i.test(value);
}

function safeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 65_536
    || /authorization|password|private[_-]?key|access[_-]?token|secret/i.test(serialized)) invalid();
  return structuredClone(value) as Record<string, unknown>;
}

function safeArray(value: unknown, maxItems: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 65_536
    || /authorization|password|private[_-]?key|access[_-]?token|secret/i.test(serialized)) invalid();
  return structuredClone(value);
}

function uniqueStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  const output = value.map((item) => optionalText(item, maxLength));
  if (output.some((item) => !item) || new Set(output).size !== output.length) invalid();
  return output;
}

function uniqueIdentifiers(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  const output = value.map(identifier);
  if (new Set(output).size !== output.length) invalid();
  return output;
}

function enumeration<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) invalid();
  return value as T[number];
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) invalid();
  return Number(value);
}

function nullableInteger(value: unknown, minimum: number, maximum: number): number | null {
  return value === null ? null : boundedInteger(value, minimum, maximum);
}

function revision(value: unknown, allowZero = false): number {
  return boundedInteger(value, allowZero ? 0 : 1, Number.MAX_SAFE_INTEGER);
}

function required<T>(value: T | null): T {
  if (value === null) throw new IvrError({ code: 'not_found', status: 404 });
  return value;
}

function conflict(): IvrError {
  return new IvrError({ code: 'revision_conflict', status: 409 });
}

function invalid(): never {
  throw new IvrError({ code: 'validation_failed', status: 422 });
}
