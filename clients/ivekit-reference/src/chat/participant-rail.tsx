import type {
  IveKitChatParticipant,
  IveKitChatRealtimeState,
  IveKitPolicyFinding,
  IveKitPolicyFindingResult,
  IveKitPolicyFindingReviewInput
} from '@opc/ivekit-sdk';
import { ShieldAlert, Users, X } from 'lucide-react';
import React from 'react';
import { FindingPanel } from './finding-panel.js';

export function ParticipantRail(props: {
  participants: IveKitChatParticipant[];
  realtime: IveKitChatRealtimeState[];
  findings: IveKitPolicyFinding[];
  identity: string;
  selectedFindingId: string;
  findingDetail: IveKitPolicyFindingResult | null;
  onSelectFinding(id: string): void;
  onCloseFinding(): void;
  onLoadFinding(id: string): Promise<IveKitPolicyFindingResult>;
  onReviewFinding(id: string, input: IveKitPolicyFindingReviewInput): Promise<IveKitPolicyFindingResult>;
}) {
  const state = new Map(props.realtime.map((item) => [item.identity, item]));
  const reviewer = props.participants.some((participant) =>
    participant.identity === props.identity && !participant.left_at &&
    ['agent', 'engineer', 'supervisor', 'admin'].includes(participant.role)
  );
  return <aside className={`detail-pane${props.selectedFindingId ? ' finding-open' : ''}`}>
    <div className="pane-heading"><h2>Participants</h2><Users size={17} /></div>
    <div className="participant-list">{props.participants.map((participant) => {
      const realtime = state.get(participant.identity);
      return <div className="participant" key={participant.id}><i className={`presence ${realtime?.presence_status || 'offline'}`} /><span><strong>{participant.display_name || participant.identity}</strong><small>{participant.role}{realtime?.typing ? ' · typing' : ''}</small></span></div>;
    })}</div>
    <div className="pane-heading compact"><h2>Quality</h2><span className="quality-heading-actions"><ShieldAlert size={16} /><button className="icon-button light mobile-finding-close" title="Close quality review" onClick={props.onCloseFinding}><X size={16} /></button></span></div>
    <FindingPanel
      findings={props.findings}
      selectedId={props.selectedFindingId}
      detail={props.findingDetail}
      canReview={reviewer}
      onSelect={props.onSelectFinding}
      onLoadDetail={props.onLoadFinding}
      onReview={props.onReviewFinding}
    />
  </aside>;
}
