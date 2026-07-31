/**
 * Shared metadata helpers for call-center modules.
 *
 * Extracted from 5+ duplicate readMetadata implementations across
 * agent-tools/ (conference, warm-transfer-bridge, call-hold,
 * recording-pci, call-transfer, supervisor).
 */

/** Safely read voice_call_sessions.metadata JSON into a plain object. */
export function readMetadata(session: { metadata?: unknown }): Record<string, unknown> {
  return session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
}
