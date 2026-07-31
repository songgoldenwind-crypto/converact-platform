ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS media_call_id TEXT;

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS room_name TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_call_recordings_media_call
  ON call_recordings(tenant_id, media_call_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_call_recordings_room
  ON call_recordings(tenant_id, room_name, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_active_room
  ON call_recordings(tenant_id, room_name)
  WHERE room_name != '' AND status IN ('starting', 'pending', 'recording', 'stopping');
