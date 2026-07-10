import { create } from 'zustand';

export type SeatStatus = 'idle' | 'busy' | 'wrap_up' | 'offline' | 'break' | 'away';

export interface QueueItem {
  id: string;
  call_session_id: string;
  room_name: string;
  customer_name: string;
  customer_phone: string;
  customer_summary: string;
  intent_score: number;
  waitingSince: string;
}

export interface CurrentCallInfo {
  call_session_id: string;
  room_name: string;
  livekit_token?: string;
  customer_name?: string;
  ai_summary?: string;
}

interface AgentState {
  seatId: string | null;
  tenantId: string | null;
  status: SeatStatus;
  queue: QueueItem[];
  currentCall: CurrentCallInfo | null;
  transcript: Array<{ role: string; text: string }>;
  setSeatId: (seatId: string | null) => void;
  setTenantId: (tenantId: string | null) => void;
  setStatus: (status: SeatStatus) => void;
  setQueue: (queue: QueueItem[]) => void;
  setCurrentCall: (call: CurrentCallInfo | null) => void;
  appendTranscript: (entry: { role: string; text: string }) => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  seatId: localStorage.getItem('opc_seat_id'),
  tenantId: localStorage.getItem('opc_tenant_id'),
  status: 'offline',
  queue: [],
  currentCall: null,
  transcript: [],
  setSeatId: (seatId) => {
    if (seatId) localStorage.setItem('opc_seat_id', seatId);
    set({ seatId });
  },
  setTenantId: (tenantId) => {
    if (tenantId) localStorage.setItem('opc_tenant_id', tenantId);
    set({ tenantId });
  },
  setStatus: (status) => set({ status }),
  setQueue: (queue) => set({ queue }),
  setCurrentCall: (currentCall) => set({ currentCall }),
  appendTranscript: (entry) => set((state) => ({ transcript: [...state.transcript, entry] }))
}));
