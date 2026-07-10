import { readMetadata } from '../metadata-helpers.js';

import { readEgressConfigFromEnv } from '../../../recording-policy.js';
import type { VoiceStore } from '../../voice/voice-store.js';
import { EgressManager } from '../egress-manager.js';

export interface PciRecordingState {
  call_session_id: string;
  recording_paused: boolean;
  pci_mode: boolean;
  egress_id?: string | null;
}

export class RecordingPciService {
  constructor(
    private readonly db: unknown,
    private readonly voiceStore: VoiceStore
  ) {}

  async pauseForPci(tenantId: string, callSessionId: string): Promise<PciRecordingState> {
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const metadata = readMetadata(session);
    if (metadata.recording_paused === true) {
      throw Object.assign(new Error('recording already paused for PCI'), { status: 409 });
    }

    const egress = new EgressManager(this.db, readEgressConfigFromEnv());
    const recording = egress.getRecordingBySession(callSessionId);
    if (recording?.egress_id) {
      await egress.stopRecording(recording.egress_id);
    }

    // Persist original recording format so resume can restore it.
    const originalFormat = (recording as { format?: string })?.format
      || (metadata.recording_format as string)
      || 'mp4';

    this.voiceStore.updateCallSession(tenantId, callSessionId, {
      metadata: {
        ...metadata,
        recording_paused: true,
        pci_mode: true,
        pci_paused_at: new Date().toISOString(),
        recording_format: originalFormat
      }
    });

    return {
      call_session_id: callSessionId,
      recording_paused: true,
      pci_mode: true,
      egress_id: recording?.egress_id || null
    };
  }

  async resumeAfterPci(
    tenantId: string,
    callSessionId: string,
    roomName: string
  ): Promise<PciRecordingState> {
    const session = this.voiceStore.getCallSession(tenantId, callSessionId);
    if (!session) throw Object.assign(new Error('call session not found'), { status: 404 });

    const metadata = readMetadata(session);
    if (metadata.recording_paused !== true) {
      throw Object.assign(new Error('recording not paused — cannot resume'), { status: 409 });
    }

    // Restore original recording format (was persisted during pauseForPci).
    const format = (metadata.recording_format as 'mp4' | 'webm' | 'wav' | 'ogg') || 'mp4';

    const egress = new EgressManager(this.db, readEgressConfigFromEnv());
    const record = await egress.startRecording(tenantId, callSessionId, roomName, { format });

    this.voiceStore.updateCallSession(tenantId, callSessionId, {
      metadata: {
        ...metadata,
        recording_paused: false,
        pci_mode: false,
        pci_resumed_at: new Date().toISOString(),
        egress_id: record.egress_id
      }
    });

    return {
      call_session_id: callSessionId,
      recording_paused: false,
      pci_mode: false,
      egress_id: record.egress_id
    };
  }
}

