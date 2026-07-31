import type { IveKitChatMessageInput } from '@converact/sdk';

type PendingInput = Omit<IveKitChatMessageInput, 'sender_identity'>;

export class PendingSendStore {
  private readonly entries = new Map<string, { idempotencyKey: string; input: PendingInput }>();

  remember(localId: string, idempotencyKey: string, input: PendingInput) {
    this.entries.set(localId, {
      idempotencyKey,
      input: {
        ...input,
        ...(input.attachments ? { attachments: input.attachments.map((attachment) => ({ ...attachment })) } : {}),
        ...(input.mentions ? { mentions: [...input.mentions] } : {})
      }
    });
  }

  get(localId: string) {
    return this.entries.get(localId);
  }

  resolve(localId: string) {
    this.entries.delete(localId);
  }

  clear() {
    this.entries.clear();
  }
}
