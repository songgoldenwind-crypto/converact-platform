import type {
  IveKitHttpSdk,
  IveKitContactCenterMonitorSnapshot
} from '@converact/sdk';
import {
  AlertTriangle,
  BellRing,
  CheckCircle2,
  Clock3,
  Headset,
  RefreshCw,
  UsersRound
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type QueueStatusFilter = 'all' | 'active' | 'disabled';
type MonitorQueue = IveKitContactCenterMonitorSnapshot['queues'][number];
type MonitorAlert = IveKitContactCenterMonitorSnapshot['alerts'][number];

export function QueueMonitorWorkspace(props: {
  client: IveKitHttpSdk | null;
  pollIntervalMs?: number;
}) {
  const [snapshot, setSnapshot] = useState<IveKitContactCenterMonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [status, setStatus] = useState<QueueStatusFilter>('all');
  const [alertsOnly, setAlertsOnly] = useState(false);
  const request = useRef(0);
  const inFlight = useRef<{
    client: IveKitHttpSdk;
    promise: Promise<IveKitContactCenterMonitorSnapshot>;
  } | null>(null);
  const pollIntervalMs = Math.max(1_000, props.pollIntervalMs ?? 10_000);

  const refresh = useCallback(async (): Promise<void> => {
    const client = props.client;
    if (!client) return;
    const currentRequest = ++request.current;
    setLoading(true);
    const flight = inFlight.current?.client === client
      ? inFlight.current
      : { client, promise: client.contactCenter.getMonitorSnapshot() };
    inFlight.current = flight;
    try {
      const next = await flight.promise;
      if (request.current !== currentRequest) return;
      setSnapshot(next);
      setError('');
    } catch (cause) {
      if (request.current === currentRequest) setError(errorMessage(cause));
    } finally {
      if (request.current === currentRequest) setLoading(false);
      if (inFlight.current === flight) inFlight.current = null;
    }
  }, [props.client]);

  useEffect(() => {
    request.current += 1;
    setSnapshot(null);
    setError('');
    setLoading(false);
    if (props.client) void refresh();
    return () => { request.current += 1; };
  }, [props.client, refresh]);

  useEffect(() => {
    if (!props.client || !autoRefresh) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, pollIntervalMs);
    return () => window.clearInterval(timer);
  }, [autoRefresh, pollIntervalMs, props.client, refresh]);

  const alertedQueues = useMemo(() => new Set(
    snapshot?.alerts.map((alert) => alert.queue_id) || []
  ), [snapshot?.alerts]);
  const queues = useMemo(() => snapshot?.queues.filter((queue) =>
    (status === 'all' || queue.status === status) &&
    (!alertsOnly || alertedQueues.has(queue.queue_id))
  ) || [], [alertedQueues, alertsOnly, snapshot?.queues, status]);

  if (!props.client) return <section className="queue-monitor queue-monitor-empty">
    <Headset size={32} />
    <strong>Operations unavailable</strong>
  </section>;

  if (!snapshot && loading) return <section className="queue-monitor queue-monitor-empty" aria-busy="true">
    <RefreshCw className="spin" size={28} />
    <strong>Loading queue monitor</strong>
  </section>;

  if (!snapshot) return <section className="queue-monitor queue-monitor-empty">
    <AlertTriangle size={30} />
    <strong>Queue monitor unavailable</strong>
    {error && <p role="alert">{error}</p>}
    <button onClick={() => void refresh()}>Retry</button>
  </section>;

  const totals = queueTotals(snapshot);
  return <section className="queue-monitor" aria-label="Contact Center queue monitor">
    <header className="queue-monitor-header">
      <div>
        <Headset size={18} />
        <span><strong>Queue monitor</strong><small>Updated {formatTimestamp(snapshot.generated_at)}</small></span>
      </div>
      <label className="queue-auto-refresh">
        <input
          type="checkbox"
          checked={autoRefresh}
          onChange={(event) => setAutoRefresh(event.target.checked)}
        />
        <span>Auto refresh</span>
      </label>
      <button
        className="queue-refresh"
        title="Refresh queue monitor"
        disabled={loading}
        onClick={() => void refresh()}
      ><RefreshCw className={loading ? 'spin' : ''} size={16} /></button>
    </header>

    <div className="queue-metrics" aria-label="Contact Center totals">
      <Metric icon={<UsersRound size={17} />} label="Waiting" value={totals.waiting} testId="metric-waiting" tone={totals.waiting ? 'warning' : 'normal'} />
      <Metric icon={<Headset size={17} />} label="Available agents" value={snapshot.agents.available} />
      <Metric icon={<CheckCircle2 size={17} />} label="Available capacity" value={totals.capacity} testId="metric-capacity" />
      <Metric icon={<Headset size={17} />} label="Active calls" value={totals.activeCalls} testId="metric-active-calls" />
      <Metric icon={<Clock3 size={17} />} label="Callbacks pending" value={snapshot.operations.callbacks_pending} />
      <Metric icon={<BellRing size={17} />} label="Critical alerts" value={totals.criticalAlerts} tone={totals.criticalAlerts ? 'critical' : 'normal'} />
    </div>

    <div className="queue-monitor-body">
      <section className="queue-alert-panel" aria-label="Operational alerts">
        <header><BellRing size={15} /><strong>Alerts</strong><span>{snapshot.alerts.length}</span></header>
        {snapshot.alerts.length ? <div className="queue-alert-list">
          {snapshot.alerts.map((alert, index) => <QueueAlert
            key={`${alert.queue_id}:${alert.code}:${index}`}
            alert={alert}
            queue={snapshot.queues.find((queue) => queue.queue_id === alert.queue_id)}
          />)}
        </div> : <div className="queue-alert-empty"><CheckCircle2 size={17} />No active alerts</div>}
      </section>

      <section className="queue-table-panel" aria-label="Queue status table">
        <header className="queue-table-controls">
          <div className="queue-status-filter" role="group" aria-label="Queue status">
            {(['all', 'active', 'disabled'] as const).map((value) => <button
              key={value}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >{capitalize(value)}</button>)}
          </div>
          <label><input type="checkbox" checked={alertsOnly} onChange={(event) => setAlertsOnly(event.target.checked)} />Only queues with alerts</label>
          <span>{queues.length} queues</span>
        </header>
        <div className="queue-table-scroll">
          <table className="queue-table">
            <thead><tr>
              <th>Queue</th><th>Live traffic</th><th>Capacity</th><th>Wait</th>
              <th>Service level</th><th>Today</th><th>Operations</th>
            </tr></thead>
            <tbody>
              {queues.map((queue) => <QueueRow
                key={queue.queue_id}
                queue={queue}
                alerted={alertedQueues.has(queue.queue_id)}
              />)}
            </tbody>
          </table>
          {!queues.length && <div className="queue-table-empty">No queues match the current filter</div>}
        </div>
      </section>
    </div>
    {error && <div className="queue-monitor-error" role="alert">
      <AlertTriangle size={15} /><span>{error}</span>
      <button onClick={() => void refresh()}>Retry</button>
    </div>}
  </section>;
}

function Metric(props: {
  icon: ReactNode;
  label: string;
  value: number;
  testId?: string;
  tone?: 'normal' | 'warning' | 'critical';
}) {
  return <div className={`queue-metric metric-${props.tone || 'normal'}`}>
    {props.icon}<span>{props.label}</span>
    <strong data-testid={props.testId}>{props.value}</strong>
  </div>;
}

function QueueAlert(props: { alert: MonitorAlert; queue?: MonitorQueue }) {
  return <article className={`queue-alert alert-${props.alert.severity}`}>
    <AlertTriangle size={15} />
    <div><strong>{alertLabel(props.alert.code)}</strong><small>{props.queue?.queue_name || props.alert.queue_id}</small></div>
    <span>{alertValue(props.alert)}</span>
  </article>;
}

function QueueRow(props: { queue: MonitorQueue; alerted: boolean }) {
  const queue = props.queue;
  return <tr className={props.alerted ? 'queue-row-alerted' : ''}>
    <td><strong>{queue.queue_name}</strong><span>{queue.routing_strategy.replaceAll('_', ' ')}</span><em className={`queue-status status-${queue.status}`}>{queue.status}</em></td>
    <td><strong>{queue.waiting_count} waiting</strong><span>{queue.offered_count} offered · {queue.assigned_count} assigned</span></td>
    <td><strong>{queue.available_capacity} slots</strong><span>{queue.available_agents} agents</span></td>
    <td><strong>{formatDuration(queue.oldest_wait_seconds)} oldest</strong><span>{queue.estimated_wait_seconds == null ? 'No capacity' : `${formatDuration(queue.estimated_wait_seconds)} estimated`}</span></td>
    <td><strong>{formatPercent(queue.service_level_percent_today)}</strong><progress max="100" value={queue.service_level_percent_today} /><span>Target {queue.service_level_seconds}s</span></td>
    <td><strong>{queue.answered_today} answered</strong><span>{queue.abandoned_today} abandoned · {queue.timed_out_today} timed out</span></td>
    <td><strong>{queue.callbacks_pending} callbacks</strong><span>{queue.overflows_pending} overflows · {queue.callbacks_failed_today + queue.overflows_failed_today} failed</span></td>
  </tr>;
}

function queueTotals(snapshot: IveKitContactCenterMonitorSnapshot) {
  return {
    waiting: snapshot.queues.reduce((total, queue) => total + queue.waiting_count, 0),
    capacity: Math.max(0, snapshot.agents.voice_capacity - snapshot.agents.active_voice_count),
    activeCalls: snapshot.calls.active_inbound + snapshot.calls.active_outbound,
    criticalAlerts: snapshot.alerts.filter((alert) => alert.severity === 'critical').length
  };
}

function alertLabel(code: MonitorAlert['code']): string {
  return {
    queue_without_capacity: 'No agent capacity',
    service_level_wait: 'Service level wait exceeded',
    callback_failures: 'Callback failures',
    overflow_failures: 'Overflow failures'
  }[code];
}

function alertValue(alert: MonitorAlert): string {
  if (alert.code === 'service_level_wait') return formatDuration(alert.value);
  return String(alert.value);
}

function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const remainder = value % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function formatPercent(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
