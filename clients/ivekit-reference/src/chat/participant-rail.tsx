import type { IveKitChatParticipant, IveKitChatRealtimeState, IveKitPolicyFinding } from '@opc/ivekit-sdk';
import { ShieldAlert, Users } from 'lucide-react';

export function ParticipantRail(props: {
  participants: IveKitChatParticipant[];
  realtime: IveKitChatRealtimeState[];
  findings: IveKitPolicyFinding[];
}) {
  const state = new Map(props.realtime.map((item) => [item.identity, item]));
  return <aside className="detail-pane">
    <div className="pane-heading"><h2>Participants</h2><Users size={17} /></div>
    <div className="participant-list">{props.participants.map((participant) => {
      const realtime = state.get(participant.identity);
      return <div className="participant" key={participant.id}><i className={`presence ${realtime?.presence_status || 'offline'}`} /><span><strong>{participant.display_name || participant.identity}</strong><small>{participant.role}{realtime?.typing ? ' · typing' : ''}</small></span></div>;
    })}</div>
    <div className="pane-heading compact"><h2>Quality</h2><ShieldAlert size={16} /></div>
    <div className="finding-list">{props.findings.slice(0, 20).map((finding) => <div className={`finding ${finding.severity}`} key={finding.id}><strong>{finding.policy_type}</strong><span>{finding.source} · {finding.review_status}</span></div>)}{!props.findings.length && <p className="empty">No findings</p>}</div>
  </aside>;
}
