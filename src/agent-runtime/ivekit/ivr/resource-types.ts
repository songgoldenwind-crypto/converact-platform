export type IvrResourceKind = 'audio_asset' | 'time_group' | 'region_group' | 'ring_group';

export interface IvrResourceBase {
  id: string;
  tenant_id: string;
  kind: IvrResourceKind;
  name: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface IvrAudioAsset extends IvrResourceBase {
  kind: 'audio_asset';
  source_kind: 'audio_file' | 'tts' | 'variable';
  object_ref: string;
  tts_text: string;
  tts_profile_id: string;
  variable_name: string;
  language: string;
  content_type: string;
  checksum: string;
  duration_ms: number | null;
  visibility: 'tenant' | 'flow';
  status: 'active' | 'processing' | 'failed' | 'archived';
  metadata: Record<string, unknown>;
  created_by: string;
  updated_by: string;
}

export interface IvrTimeGroup extends IvrResourceBase {
  kind: 'time_group';
  timezone: string;
  schedule: Record<string, unknown>;
  holidays: unknown[];
  status: 'active' | 'disabled' | 'archived';
}

export interface IvrRegionGroup extends IvrResourceBase {
  kind: 'region_group';
  regions: string[];
  match_mode: 'prefix' | 'exact' | 'regex';
  status: 'active' | 'disabled' | 'archived';
}

export interface IvrRingGroup extends IvrResourceBase {
  kind: 'ring_group';
  member_identities: string[];
  strategy: 'simultaneous' | 'sequential' | 'least_busy' | 'random';
  ring_timeout_seconds: number;
  max_rounds: number;
  status: 'active' | 'disabled' | 'archived';
}

export type IvrResource = IvrAudioAsset | IvrTimeGroup | IvrRegionGroup | IvrRingGroup;

export interface IvrSettings {
  id: string;
  tenant_id: string;
  default_language: string;
  max_steps: number;
  max_subflow_depth: number;
  external_action_timeout_ms: number;
  validation_mode: 'warn' | 'block';
  allowed_webhook_refs: string[];
  execution_policy: Record<string, unknown>;
  revision: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface IvrPublishedResourceReference {
  flow_id: string;
  version: number;
}

export interface IvrResourceRepository {
  list<K extends IvrResourceKind>(
    tenantId: string,
    kind: K
  ): Promise<Array<Extract<IvrResource, { kind: K }>>>;
  get<K extends IvrResourceKind>(
    tenantId: string,
    kind: K,
    id: string,
    options?: { for_update?: boolean }
  ): Promise<Extract<IvrResource, { kind: K }> | null>;
  insert<K extends IvrResourceKind>(
    resource: Extract<IvrResource, { kind: K }>
  ): Promise<Extract<IvrResource, { kind: K }>>;
  update<K extends IvrResourceKind>(
    resource: Extract<IvrResource, { kind: K }>,
    expectedRevision: number
  ): Promise<Extract<IvrResource, { kind: K }>>;
  currentPublishedReferences(
    tenantId: string,
    kind: IvrResourceKind,
    id: string
  ): Promise<IvrPublishedResourceReference[]>;
  getSettings(tenantId: string, options?: { for_update?: boolean }): Promise<IvrSettings | null>;
  insertSettings(settings: IvrSettings): Promise<IvrSettings>;
  updateSettings(settings: IvrSettings, expectedRevision: number): Promise<IvrSettings>;
}

export interface IvrResourceUnitOfWorkContext {
  resources: IvrResourceRepository;
}

export interface IvrResourceUnitOfWork {
  run<T>(
    tenantId: string,
    operation: (context: IvrResourceUnitOfWorkContext) => Promise<T>
  ): Promise<T>;
}

