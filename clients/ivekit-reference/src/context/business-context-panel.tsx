import type { IveKitBusinessContext } from '@opc/ivekit-sdk';
import { MessageSquare, MonitorCog, ShieldCheck, Users, Video, X } from 'lucide-react';

export function BusinessContextPanel(props: {
  context: IveKitBusinessContext;
  onClose(): void;
}) {
  const authorization = props.context.authorization;
  return <aside className="business-context-panel" aria-label="Business authorization summary">
    <header>
      <div><ShieldCheck size={17} /><span><strong>Authorization</strong><small>{props.context.viewer.identity}</small></span></div>
      <button title="Close authorization summary" onClick={props.onClose}><X size={16} /></button>
    </header>
    <section>
      <h2><MessageSquare size={15} /> Messages</h2>
      {authorization.chat.length ? authorization.chat.map((item) => <div className="authorization-resource" key={item.session_id}>
        <span><strong>{item.viewer_role || 'System view'}</strong><small>{item.session_id}</small></span>
        <span><Users size={13} /> {activeCount(item.participants)} active / {item.participants.length}</span>
      </div>) : <p>No visible message session</p>}
    </section>
    <section>
      <h2><Video size={15} /> Calls</h2>
      {authorization.media.length ? authorization.media.map((item) => <div className="authorization-resource" key={item.call_id}>
        <span><strong>{item.viewer_role || 'System view'}</strong><small>{item.viewer_status || item.call_id}</small></span>
        <span><Users size={13} /> {item.participants.length} participants</span>
      </div>) : <p>No visible call</p>}
    </section>
    <section>
      <h2><MonitorCog size={15} /> Remote</h2>
      {authorization.remote_assistance.length ? authorization.remote_assistance.map((item) => <div className="remote-authorization" key={item.remote_session_id}>
        <div className="authorization-resource">
          <span><strong>{item.viewer_role || 'System view'}</strong><small>{item.remote_session_id}</small></span>
          <span>{item.consent.active ? `${item.consent.scopes.length} scopes` : 'No active consent'}</span>
        </div>
        <dl>
          <dt>Consent</dt><dd>{item.consent.scopes.join(', ') || 'None'}</dd>
          <dt>Control</dt><dd>{item.gateway?.controller.owner_identity || item.gateway?.controller.status || 'No gateway'}</dd>
          <dt>Gateway</dt><dd>{item.gateway?.status || 'Not active'}</dd>
        </dl>
      </div>) : <p>No visible remote session</p>}
    </section>
  </aside>;
}

function activeCount(participants: Array<{ status: string }>): number {
  return participants.filter((participant) => participant.status === 'active').length;
}
