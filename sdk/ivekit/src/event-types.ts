export type IveKitEventVisibilityScope =
  | 'tenant'
  | 'chat_session'
  | 'media_call'
  | 'remote_session';

export type IveKitEventSnapshotReason =
  | 'invalid_cursor'
  | 'cursor_tenant_mismatch'
  | 'cursor_expired';

export interface IveKitEvent<T = unknown> {
  event_id: string;
  cursor: string;
  tenant_id: string;
  type: string;
  data: T;
  timestamp: string;
  expires_at: string;
  visibility_scope: IveKitEventVisibilityScope;
  visibility_ref_id: string;
  audience_user_ids: string[];
}

export interface IveKitEventPage<T = unknown> {
  items: IveKitEvent<T>[];
  next_cursor: string;
  has_more: boolean;
  snapshot_required: boolean;
  reason?: IveKitEventSnapshotReason;
}

export interface IveKitEventPageInput {
  cursor: string;
  limit?: number;
}

export interface IveKitEventReplayInput extends IveKitEventPageInput {
  max_pages?: number;
}

export interface IveKitEventReplayResult<T = unknown> extends IveKitEventPage<T> {
  pages: number;
}
