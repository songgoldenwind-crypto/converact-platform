import type { BusinessRefSelection } from './context/use-business-context.js';

export type WorkspaceMode = 'messages' | 'calls' | 'voice' | 'remote' | 'quality';

export interface IveKitLocationState {
  workspace: WorkspaceMode;
  businessRef: BusinessRefSelection | null;
  sessionId: string;
  callId: string;
  voiceCallId: string;
  remoteSessionId: string;
}

export type IveKitLocationPatch = Partial<Omit<IveKitLocationState, 'businessRef'>> & {
  businessRef?: BusinessRefSelection | null;
};

export function readIveKitLocation(value: string | URL): IveKitLocationState {
  const url = typeof value === 'string' ? new URL(value, 'http://ivekit.local') : value;
  const callId = parameter(url, 'call_id');
  const voiceCallId = parameter(url, 'voice_call_id');
  const workspaceValue = parameter(url, 'workspace');
  const workspace = workspaceValue === 'messages' || workspaceValue === 'calls' || workspaceValue === 'voice' || workspaceValue === 'remote' || workspaceValue === 'quality'
    ? workspaceValue
    : voiceCallId ? 'voice' : callId ? 'calls' : 'messages';
  const type = parameter(url, 'business_ref_type');
  const id = parameter(url, 'business_ref_id');
  return {
    workspace,
    businessRef: type && id ? { type, id } : null,
    sessionId: parameter(url, 'session_id'),
    callId,
    voiceCallId,
    remoteSessionId: parameter(url, 'remote_session_id')
  };
}

export function updateIveKitLocation(value: string | URL, patch: IveKitLocationPatch): URL {
  const url = new URL(typeof value === 'string' ? value : value.toString(), 'http://ivekit.local');
  if (patch.businessRef !== undefined) {
    setParameter(url, 'business_ref_type', patch.businessRef?.type || '');
    setParameter(url, 'business_ref_id', patch.businessRef?.id || '');
  }
  if (patch.workspace !== undefined) setParameter(url, 'workspace', patch.workspace);
  if (patch.sessionId !== undefined) setParameter(url, 'session_id', patch.sessionId);
  if (patch.callId !== undefined) setParameter(url, 'call_id', patch.callId);
  if (patch.voiceCallId !== undefined) setParameter(url, 'voice_call_id', patch.voiceCallId);
  if (patch.remoteSessionId !== undefined) setParameter(url, 'remote_session_id', patch.remoteSessionId);
  return url;
}

export function sessionLocationPatch(
  currentBusinessRef: BusinessRefSelection | null,
  nextBusinessRef: BusinessRefSelection,
  sessionId: string
): IveKitLocationPatch {
  const businessChanged = currentBusinessRef?.type !== nextBusinessRef.type ||
    currentBusinessRef.id !== nextBusinessRef.id;
  return {
    businessRef: nextBusinessRef,
    sessionId,
    ...(businessChanged ? { callId: '', voiceCallId: '', remoteSessionId: '' } : {})
  };
}

function parameter(url: URL, name: string): string {
  return url.searchParams.get(name)?.trim() || '';
}

function setParameter(url: URL, name: string, value: string): void {
  const normalized = value.trim();
  if (normalized) url.searchParams.set(name, normalized);
  else url.searchParams.delete(name);
}
