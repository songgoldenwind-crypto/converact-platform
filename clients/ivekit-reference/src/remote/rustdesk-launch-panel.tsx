import type {
  IveKitRustDeskClient,
  RemoteConsentScope,
  RustDeskControlOwnership,
  RustDeskDevice,
  RustDeskGatewayLaunchPlan
} from '@opc/ivekit-sdk';
import {
  ClipboardCheck, ExternalLink, KeyRound, Laptop, LoaderCircle, LogOut,
  RefreshCw, Search, ShieldCheck, UserRoundCheck
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const CONTROL_SCOPES: Array<{ value: RemoteConsentScope; label: string }> = [
  { value: 'view_screen', label: 'View screen' },
  { value: 'control_mouse_keyboard', label: 'Keyboard and mouse' },
  { value: 'transfer_file', label: 'File transfer' },
  { value: 'clipboard', label: 'Clipboard' },
  { value: 'record_screen', label: 'Screen recording' }
];

interface RustDeskLaunchPanelProps {
  client: IveKitRustDeskClient | null;
  identity: string;
  onError?(error: unknown): void;
  openProtocol?(url: string): void;
  initialBusinessRef?: { type: string; id: string };
  initialRemoteSessionId?: string;
  initialAccessMode?: 'attended' | 'unattended';
  controlHeartbeatIntervalMs?: number;
}

export function RustDeskLaunchPanel({
  client,
  identity,
  onError,
  openProtocol = (url) => window.location.assign(url),
  initialBusinessRef,
  initialRemoteSessionId = '',
  initialAccessMode = 'attended',
  controlHeartbeatIntervalMs = 10_000
}: RustDeskLaunchPanelProps) {
  const [businessType, setBusinessType] = useState(initialBusinessRef?.type || 'service_order');
  const [businessId, setBusinessId] = useState(initialBusinessRef?.id || '');
  const [remoteSessionId, setRemoteSessionId] = useState(initialRemoteSessionId);
  const [devices, setDevices] = useState<RustDeskDevice[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [scopes, setScopes] = useState<RemoteConsentScope[]>(['view_screen', 'control_mouse_keyboard']);
  const [accessMode, setAccessMode] = useState<'attended' | 'unattended'>(initialAccessMode);
  const [externalId, setExternalId] = useState('');
  const [plan, setPlan] = useState<RustDeskGatewayLaunchPlan | null>(null);
  const [ownership, setOwnership] = useState<RustDeskControlOwnership | null>(null);
  const [auditCount, setAuditCount] = useState(0);
  const [disconnectStatus, setDisconnectStatus] = useState('not requested');
  const [transferTarget, setTransferTarget] = useState('');
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('Ready');

  const selectedDevice = useMemo(
    () => devices.find((device) => device.id === deviceId) || null,
    [deviceId, devices]
  );
  const sessionActive = plan?.status === 'active';
  const grantedScopes = plan?.permission_scopes?.granted || plan?.permissions || [];

  const run = useCallback(async <T,>(label: string, action: () => Promise<T>): Promise<T | null> => {
    if (!client) return null;
    setBusy(label);
    try {
      const result = await action();
      setStatus(label);
      return result;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
      onError?.(error);
      return null;
    } finally {
      setBusy('');
    }
  }, [client, onError]);

  const resolveDevices = useCallback(async () => {
    const found = await run('Devices resolved', () => client!.listDevicesByBusinessRef({
      business_ref: { type: businessType.trim(), id: businessId.trim() }
    }));
    if (!found) return;
    setDevices(found);
    setDeviceId((current) => found.some((device) => device.id === current) ? current : found[0]?.id || '');
  }, [businessId, businessType, client, run]);

  const loadLaunchPlan = useCallback(async (sessionId: string, unattended: boolean) => {
    if (!client) return null;
    if (!unattended) return client.getGatewayLaunchPlan(sessionId);
    const confirmation = await client.issueControlConfirmation(sessionId, {
      operation: 'unattended_launch'
    });
    return client.getGatewayLaunchPlan(sessionId, { confirmation_id: confirmation.id });
  }, [client]);

  const startSession = useCallback(async () => {
    const tool = await run('Remote session created', () => client!.startGatewaySession({
      remote_session_id: remoteSessionId.trim(),
      device_id: deviceId,
      actor_identity: identity,
      permissions: scopes,
      access_mode: accessMode,
      metadata: { source: 'ivekit-reference-client' }
    }));
    if (!tool) return;
    setExternalId(tool.external_id);
    const launch = await run('Launch plan ready', () => loadLaunchPlan(tool.external_id, accessMode === 'unattended'));
    if (!launch) return;
    setPlan(launch);
    const remoteState = await run('Remote session ready', async () => {
      const [current, events] = await Promise.all([
        client!.getControlOwnership(tool.external_id),
        client!.listGatewayAuditEvents(tool.external_id)
      ]);
      return { current, auditCount: events.length };
    });
    if (!remoteState) return;
    setOwnership(remoteState.current);
    setAuditCount(remoteState.auditCount);
  }, [accessMode, client, deviceId, identity, loadLaunchPlan, remoteSessionId, run, scopes]);

  const refreshState = useCallback(async () => {
    if (!client || !externalId) return;
    const refreshed = await run('Remote state refreshed', async () => {
      const [nextPlan, nextOwnership, events, disconnect] = await Promise.all([
        accessMode === 'attended' ? loadLaunchPlan(externalId, false) : Promise.resolve(null),
        client.getControlOwnership(externalId),
        client.listGatewayAuditEvents(externalId),
        client.getGatewayDisconnectState(externalId)
      ]);
      return { nextPlan, nextOwnership, events, disconnect };
    });
    if (!refreshed) return;
    if (refreshed.nextPlan) setPlan(refreshed.nextPlan);
    setOwnership(refreshed.nextOwnership);
    setAuditCount(refreshed.events.length);
    setDisconnectStatus(
      refreshed.disconnect.status === 'pending' || refreshed.disconnect.status === 'claimed'
        ? refreshed.disconnect.status
        : refreshed.disconnect.observation_status || refreshed.disconnect.status
    );
  }, [accessMode, client, externalId, loadLaunchPlan, run]);

  useEffect(() => {
    if (
      !client || !externalId || plan?.status !== 'active' ||
      ownership?.status !== 'owned' || ownership.owner_identity !== identity
    ) return;
    let stopped = false;
    let inFlight = false;
    const renew = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await client.heartbeatControl(externalId, { version: ownership.version });
        if (!stopped) setOwnership(next);
      } catch (error) {
        onError?.(error);
        try {
          const current = await client.getControlOwnership(externalId);
          if (!stopped) setOwnership(current);
        } catch (refreshError) {
          onError?.(refreshError);
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => { void renew(); }, controlHeartbeatIntervalMs);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [client, controlHeartbeatIntervalMs, externalId, identity, onError, ownership?.owner_identity, ownership?.status, ownership?.version, plan?.status]);

  const launchNativeClient = useCallback(async () => {
    if (!client || !externalId || !selectedDevice) return;
    const refreshed = await run('Opening RustDesk', async () => {
      const next = await loadLaunchPlan(externalId, accessMode === 'unattended');
      if (!next) throw new Error('RustDesk launch plan unavailable');
      if (
        next.status !== 'active' ||
        !next.actions.can_launch ||
        next.external_id !== externalId ||
        next.target.id !== selectedDevice.rustdesk_id ||
        !next.actions.protocol_url.startsWith('rustdesk://') ||
        (plan && next.runtime.server_key_fingerprint !== plan.runtime.server_key_fingerprint)
      ) {
        throw new Error('RustDesk launch plan changed; refresh before launching');
      }
      return next;
    });
    if (!refreshed) return;
    setPlan(refreshed);
    openProtocol(refreshed.actions.protocol_url);
  }, [accessMode, client, externalId, loadLaunchPlan, openProtocol, plan, run, selectedDevice]);

  const acquireControl = useCallback(async () => {
    if (!client || !externalId) return;
    const next = await run('Control acquired', async () => {
      const confirmation = await client.issueControlConfirmation(externalId, {
        operation: 'control_mouse_keyboard'
      });
      return client.acquireControl(externalId, { confirmation_id: confirmation.id });
    });
    if (next) setOwnership(next);
  }, [client, externalId, run]);

  const releaseControl = useCallback(async () => {
    if (!client || !externalId || !ownership) return;
    const next = await run('Control released', () => client.releaseControl(externalId, {
      version: ownership.version
    }));
    if (next) setOwnership(next);
  }, [client, externalId, ownership, run]);

  const transferControl = useCallback(async () => {
    if (!client || !externalId || !ownership || !transferTarget.trim()) return;
    const next = await run('Control transferred', async () => {
      const confirmation = await client.issueControlConfirmation(externalId, {
        operation: 'control_transfer'
      });
      return client.transferControl(externalId, {
        version: ownership.version,
        to_identity: transferTarget.trim(),
        confirmation_id: confirmation.id
      });
    });
    if (next) setOwnership(next);
  }, [client, externalId, ownership, run, transferTarget]);

  const endSession = useCallback(async () => {
    if (!client || !externalId) return;
    const ended = await run('Remote session ended', () => client.endGatewaySession(externalId, {
      actor_identity: identity
    }));
    if (ended === null) return;
    setPlan((current) => current ? { ...current, status: 'ended', launch_url: '', ended_at: new Date().toISOString(), actions: { ...current.actions, can_launch: false, open_url: '', protocol_url: '' } } : null);
    setDisconnectStatus('requested');
  }, [client, externalId, identity, run]);

  return <section className="remote-workspace-pane">
    <header className="remote-header">
      <div><Laptop size={18} /><span><strong>Remote assistance</strong><small>{status}</small></span></div>
      <button className="icon-button light" title="Refresh remote state" disabled={!externalId || Boolean(busy)} onClick={() => void refreshState()}><RefreshCw size={17} /></button>
    </header>

    <div className="remote-layout">
      <aside className="remote-setup">
        <h2>Target</h2>
        <label><span>Business type</span><input disabled={sessionActive} value={businessType} onChange={(event) => setBusinessType(event.target.value)} /></label>
        <label><span>Business ID</span><input disabled={sessionActive} value={businessId} onChange={(event) => setBusinessId(event.target.value)} /></label>
        <button className="remote-command secondary" disabled={sessionActive || !client || !businessType.trim() || !businessId.trim() || Boolean(busy)} onClick={() => void resolveDevices()}>{busy === 'Devices resolved' ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />} Resolve devices</button>
        <label><span>Device</span><select disabled={sessionActive} value={deviceId} onChange={(event) => setDeviceId(event.target.value)}><option value="">Select a device</option>{devices.map((device) => <option key={device.id} value={device.id}>{device.display_name} · {device.rustdesk_id}</option>)}</select></label>
        <label><span>Remote session ID</span><input disabled={sessionActive} value={remoteSessionId} onChange={(event) => setRemoteSessionId(event.target.value)} /></label>
        <fieldset disabled={sessionActive}><legend>Permissions</legend>{CONTROL_SCOPES.map((scope) => <label key={scope.value} className="scope-option"><input type="checkbox" checked={scopes.includes(scope.value)} onChange={() => setScopes((current) => current.includes(scope.value) ? current.filter((value) => value !== scope.value) : [...current, scope.value])} /><span>{scope.label}</span></label>)}</fieldset>
        <div className="mode-switch remote-mode" role="group" aria-label="Remote access mode"><button disabled={sessionActive} aria-pressed={accessMode === 'attended'} onClick={() => setAccessMode('attended')}>Attended</button><button disabled={sessionActive} aria-pressed={accessMode === 'unattended'} onClick={() => setAccessMode('unattended')}>Unattended</button></div>
        <button className="remote-command" disabled={sessionActive || !client || !identity || !deviceId || !remoteSessionId.trim() || !scopes.length || Boolean(busy)} onClick={() => void startSession()}><ShieldCheck size={16} /> Start session</button>
      </aside>

      <div className="remote-main">
        {!plan ? <div className="remote-empty"><Laptop size={30} /><strong>No active remote session</strong><span>Resolve a registered device and start an authorized session.</span></div> : <>
          <section className="remote-status-band">
            <div><span>Session</span><strong>{plan.status}</strong><small>{externalId}</small></div>
            <div><span>Control owner</span><strong>{ownership?.owner_identity || 'Unowned'}</strong><small>{ownership ? `v${ownership.version}` : 'No lease'}</small></div>
            <div><span>Consent</span><strong>{grantedScopes.length} scopes</strong><small>{grantedScopes.map((scope) => CONTROL_SCOPES.find((item) => item.value === scope)?.label || scope).join(', ')}</small></div>
            <div><span>Audit</span><strong>{auditCount} events</strong><small>Disconnect: {disconnectStatus}</small></div>
          </section>
          <section className="remote-launch">
            <header><div><KeyRound size={17} /><span><strong>{selectedDevice?.display_name || plan.target.display_name || plan.target.id}</strong><small>{plan.runtime.server_key_fingerprint || 'Fingerprint unavailable'}</small></span></div><span className={`remote-state state-${plan.status}`}>{plan.status}</span></header>
            <div className="manual-config">
              <label><span>ID server</span><output>{plan.client_config.manual_fields.id_server}</output></label>
              <label><span>Relay server</span><output>{plan.client_config.manual_fields.relay_server}</output></label>
              {plan.client_config.manual_fields.api_server && <label><span>API server</span><output>{plan.client_config.manual_fields.api_server}</output></label>}
              <label><span>Public key</span><output>{plan.client_config.manual_fields.key}</output></label>
            </div>
            <div className="remote-actions">
              <button disabled={plan.status !== 'active' || Boolean(busy)} onClick={() => void launchNativeClient()}><ExternalLink size={16} /> Open RustDesk</button>
              {ownership?.status === 'owned' && ownership.owner_identity === identity
                ? <button className="secondary" disabled={Boolean(busy)} onClick={() => void releaseControl()}><LogOut size={16} /> Release</button>
                : <button className="secondary" disabled={plan.status !== 'active' || Boolean(busy)} onClick={() => void acquireControl()}><UserRoundCheck size={16} /> Take control</button>}
              <button className="danger" disabled={plan.status !== 'active' || Boolean(busy)} onClick={() => void endSession()}><LogOut size={16} /> End</button>
            </div>
          </section>
          <section className="remote-transfer">
            <header><ClipboardCheck size={16} /><strong>Transfer control</strong></header>
            <div><input aria-label="Transfer target identity" placeholder="Participant identity" value={transferTarget} onChange={(event) => setTransferTarget(event.target.value)} /><button title="Transfer control" disabled={ownership?.owner_identity !== identity || !transferTarget.trim() || Boolean(busy)} onClick={() => void transferControl()}><UserRoundCheck size={16} /></button></div>
          </section>
        </>}
      </div>
    </div>
  </section>;
}
