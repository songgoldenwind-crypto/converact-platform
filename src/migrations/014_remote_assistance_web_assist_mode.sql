ALTER TABLE IF EXISTS remote_assistance_sessions
  DROP CONSTRAINT IF EXISTS remote_assistance_sessions_mode_check;

ALTER TABLE IF EXISTS remote_assistance_sessions
  ADD CONSTRAINT remote_assistance_sessions_mode_check
  CHECK (mode IN ('screen_share', 'platform_remote_control', 'third_party_remote_tool', 'remote_desktop_gateway', 'web_remote_assist'));
