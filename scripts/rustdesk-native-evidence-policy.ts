export interface RustDeskNativeEvidencePolicyInput {
  event_type: string;
  external_id: string;
  authorization_scope: string;
  authorization_id: string;
  direction?: string;
  control_version?: number;
}

export interface RustDeskNativeEvidencePolicyDecision {
  kind: 'file' | 'screen_recording';
  root_class: 'file' | 'recording';
  authorization_scope: 'operation' | 'session';
}

export function requireRustDeskNativeEvidencePolicy(
  input: RustDeskNativeEvidencePolicyInput
): RustDeskNativeEvidencePolicyDecision {
  if (input.event_type === 'file_transfer_completed') {
    if (input.authorization_scope !== 'operation' || !input.authorization_id) {
      throw new Error('RustDesk file evidence requires operation authorization');
    }
    if (input.direction !== 'upload' && input.direction !== 'download') {
      throw new Error('RustDesk file evidence direction is required');
    }
    if (!Number.isSafeInteger(input.control_version) || Number(input.control_version) < 1) {
      throw new Error('RustDesk file evidence control_version is required');
    }
    return { kind: 'file', root_class: 'file', authorization_scope: 'operation' };
  }
  if (input.event_type === 'screen_recording_completed') {
    if (
      input.authorization_scope !== 'session' ||
      !input.external_id ||
      input.authorization_id !== input.external_id
    ) {
      throw new Error('RustDesk recording evidence requires its gateway session authorization');
    }
    if (input.direction !== undefined || input.control_version !== undefined) {
      throw new Error('RustDesk recording evidence must not include file control fields');
    }
    return { kind: 'screen_recording', root_class: 'recording', authorization_scope: 'session' };
  }
  throw new Error('RustDesk native evidence event type is unsupported');
}
