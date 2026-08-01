import type {
  ConveractFabricChatParticipant,
  ConveractFabricChatRealtimeState,
  ConveractFabricPolicyFinding,
  ConveractFabricPolicyFindingResult,
  ConveractFabricPolicyFindingReviewInput
} from '@converact/sdk';
import { ShieldAlert, Users, X } from 'lucide-react';
import React, { lazy, Suspense } from 'react';

const FindingPanel = lazy(async () => {
  const module = await import('./finding-panel.js');
  return { default: module.FindingPanel };
});

export function ParticipantRail(props: {
  participants: ConveractFabricChatParticipant[];
  realtime: ConveractFabricChatRealtimeState[];
  findings: ConveractFabricPolicyFinding[];
  identity: string;
  selectedFindingId: string;
  findingDetail: ConveractFabricPolicyFindingResult | null;
  onSelectFinding(id: string): void;
  onCloseFinding(): void;
  onLoadFinding(id: string): Promise<ConveractFabricPolicyFindingResult>;
  onReviewFinding(id: string, input: ConveractFabricPolicyFindingReviewInput): Promise<ConveractFabricPolicyFindingResult>;
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
    <Suspense fallback={<div className="finding-panel-loading" aria-busy="true" />}>
      <FindingPanel
        findings={props.findings}
        selectedId={props.selectedFindingId}
        detail={props.findingDetail}
        canReview={reviewer}
        onSelect={props.onSelectFinding}
        onLoadDetail={props.onLoadFinding}
        onReview={props.onReviewFinding}
      />
    </Suspense>
  </aside>;
}
