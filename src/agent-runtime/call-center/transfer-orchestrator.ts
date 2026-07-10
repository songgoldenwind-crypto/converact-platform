import type { AgentSeatStore, AgentSeatRow } from './seat-store.js';
import type { VoiceStore } from '../voice/voice-store.js';

export interface TransferRequest {
  tenantId: string;
  callSessionId: string;
  roomName: string;
  requiredSkills?: string[];
  reason?: string;
  customerSummary?: string;
  language?: string;
}

export interface TransferResult {
  action_taken: 'seat_assigned' | 'queued' | 'no_seats_available';
  seat?: { id: string; display_name: string; livekit_identity: string };
  queue_position?: number;
  message_for_customer: string;
}

export class TransferOrchestrator {
  constructor(
    private readonly seatStore: AgentSeatStore,
    private readonly voiceStore: VoiceStore
  ) {}

  execute(request: TransferRequest): TransferResult {
    const seat = this.seatStore.findAvailableSeat(request.tenantId, request.requiredSkills || []);

    if (seat) {
      this.seatStore.updateStatus(request.tenantId, seat.id, 'busy', request.callSessionId);

      this.voiceStore.mergeCallSessionMetadata(request.tenantId, request.callSessionId, (existing) => ({
        ...existing,
        transferred_to_seat_id: seat.id,
        transferred_to_user: seat.display_name,
        transfer_reason: request.reason || '',
        transfer_at: new Date().toISOString()
      }));

      return {
        action_taken: 'seat_assigned',
        seat: {
          id: seat.id,
          display_name: seat.display_name,
          livekit_identity: seat.livekit_identity
        },
        message_for_customer: this.getTransferMessage(request.language)
      };
    }

    const idleCount = this.seatStore.countIdleSeats(request.tenantId);
    if (idleCount === 0) {
      return {
        action_taken: 'no_seats_available',
        message_for_customer: this.getNoSeatsMessage(request.language)
      };
    }

    return {
      action_taken: 'queued',
      queue_position: 1,
      message_for_customer: this.getQueueMessage(request.language)
    };
  }

  private getTransferMessage(language?: string): string {
    switch (language) {
      case 'en': return 'Connecting you to an agent now. Please hold.';
      case 'ja': return '担当者におつなぎします。少々お待ちください。';
      default: return '正在为您转接人工客服，请稍候。';
    }
  }

  private getNoSeatsMessage(language?: string): string {
    switch (language) {
      case 'en': return 'All agents are currently busy. We will call you back shortly.';
      case 'ja': return '現在、担当者が対応中です。後ほど折り返しご連絡いたします。';
      default: return '当前所有坐席忙碌，稍后将为您回电。';
    }
  }

  private getQueueMessage(language?: string): string {
    switch (language) {
      case 'en': return 'Please hold while we connect you to the next available agent.';
      case 'ja': return '次の担当者におつなぎするまで少々お待ちください。';
      default: return '请稍候，正在为您排队等待下一位空闲坐席。';
    }
  }
}
