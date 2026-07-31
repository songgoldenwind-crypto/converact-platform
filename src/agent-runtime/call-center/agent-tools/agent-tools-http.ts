import {
  addConferenceParticipantCommand,
  adjustQueuePriorityCommand,
  advanceAgentScriptCommand,
  completeWarmTransferCommand,
  forceDisconnectCallCommand,
  getAgentScriptProgressCommand,
  getWallboardCommand,
  holdCallCommand,
  ingestVoicemailCommand,
  listAgentScriptsCommand,
  listDispositionCodesCommand,
  listRecordingsCommand,
  listVoicemailsCommand,
  parkCallCommand,
  pausePciRecordingCommand,
  pickupParkedCallCommand,
  processIvrRouteCommand,
  resumeCallCommand,
  resumePciRecordingCommand,
  setCallDispositionCommand,
  supervisorMonitorCommand,
  transferCallCommand
} from '../application.js';
import { AgentSeatStore } from '../seat-store.js';
import { resolveAuthContext } from '../../../middleware/auth.js';

function requireOperator(headers: Record<string, string | string[] | undefined>) {
  const ctx = resolveAuthContext(headers);
  if (!ctx.authenticated || !ctx.tenantId || !ctx.userId) {
    throw Object.assign(new Error('authentication required'), { status: 401 });
  }
  if (ctx.role === 'viewer') {
    throw Object.assign(new Error('operator role required'), { status: 403 });
  }
  return ctx;
}

function requireSupervisor(headers: Record<string, string | string[] | undefined>) {
  const ctx = requireOperator(headers);
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw Object.assign(new Error('supervisor role required'), { status: 403 });
  }
  return ctx;
}

export async function routeAgentToolsApi(
  db: unknown,
  method: string,
  path: string,
  url: URL,
  body: unknown,
  headers: Record<string, string | string[] | undefined>
): Promise<unknown | undefined> {
  if (path === '/api/call-center/disposition-codes' && method === 'GET') {
    const ctx = requireOperator(headers);
    return listDispositionCodesCommand(db, ctx.tenantId!);
  }

  const dispositionMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/disposition$/);
  if (dispositionMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    return setCallDispositionCommand(db, ctx.tenantId!, dispositionMatch[1], body as Record<string, unknown>);
  }

  const holdMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/hold$/);
  if (holdMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    const input = body as { seat_id?: string };
    if (!input.seat_id) return { status: 400, data: { error: 'seat_id is required' } };
    return await holdCallCommand(db, ctx.tenantId!, holdMatch[1], input.seat_id, ctx.userId!);
  }

  const resumeMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/resume$/);
  if (resumeMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    const input = body as { seat_id?: string };
    if (!input.seat_id) return { status: 400, data: { error: 'seat_id is required' } };
    return await resumeCallCommand(db, ctx.tenantId!, resumeMatch[1], input.seat_id, ctx.userId!);
  }

  const transferMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/transfer$/);
  if (transferMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    const input = body as { seat_id?: string; target_seat_id?: string; mode?: string; reason?: string };
    if (!input.seat_id || !input.target_seat_id) {
      return { status: 400, data: { error: 'seat_id and target_seat_id are required' } };
    }
    return transferCallCommand(db, ctx.tenantId!, transferMatch[1], {
      from_seat_id: input.seat_id,
      target_seat_id: input.target_seat_id,
      mode: input.mode,
      reason: input.reason
    }, ctx.userId!);
  }

  const conferenceMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/conference$/);
  if (conferenceMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    const input = body as { seat_id?: string; participant_identity?: string; participant_label?: string };
    if (!input.seat_id || !input.participant_identity) {
      return { status: 400, data: { error: 'seat_id and participant_identity are required' } };
    }
    return addConferenceParticipantCommand(db, ctx.tenantId!, conferenceMatch[1], {
      seat_id: input.seat_id,
      participant_identity: input.participant_identity,
      participant_label: input.participant_label
    }, ctx.userId!);
  }

  if (path === '/api/call-center/wallboard' && method === 'GET') {
    const ctx = requireSupervisor(headers);
    return getWallboardCommand(db, ctx.tenantId!);
  }

  if (path === '/api/call-center/recordings' && method === 'GET') {
    const ctx = requireSupervisor(headers);
    return listRecordingsCommand(db, ctx.tenantId!, {
      call_session_id: url.searchParams.get('call_session_id') || undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      q: url.searchParams.get('q') || undefined,
      date_from: url.searchParams.get('date_from') || undefined,
      date_to: url.searchParams.get('date_to') || undefined
    });
  }

  if (path === '/api/call-center/ivr/route' && method === 'POST') {
    return processIvrRouteCommand(db, body as Record<string, unknown>);
  }

  if (path === '/api/call-center/agent-scripts' && method === 'GET') {
    const ctx = requireOperator(headers);
    return listAgentScriptsCommand(db, ctx.tenantId!);
  }

  const scriptProgressMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/script$/);
  if (scriptProgressMatch && method === 'GET') {
    const ctx = requireOperator(headers);
    return getAgentScriptProgressCommand(db, ctx.tenantId!, scriptProgressMatch[1]);
  }
  if (scriptProgressMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    return advanceAgentScriptCommand(db, ctx.tenantId!, scriptProgressMatch[1]);
  }

  const pciPauseMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/recording\/pci-pause$/);
  if (pciPauseMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    return pausePciRecordingCommand(db, ctx.tenantId!, pciPauseMatch[1]);
  }

  const pciResumeMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/recording\/pci-resume$/);
  if (pciResumeMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    const input = body as { room_name?: string };
    if (!input.room_name) return { status: 400, data: { error: 'room_name is required' } };
    return resumePciRecordingCommand(db, ctx.tenantId!, pciResumeMatch[1], input.room_name);
  }

  const warmCompleteMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/warm-transfer\/complete$/);
  if (warmCompleteMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    const input = body as { from_seat_id?: string; target_seat_id?: string; reason?: string };
    if (!input.from_seat_id || !input.target_seat_id) {
      return { status: 400, data: { error: 'from_seat_id and target_seat_id are required' } };
    }
    return completeWarmTransferCommand(
      db,
      ctx.tenantId!,
      warmCompleteMatch[1],
      {
        from_seat_id: input.from_seat_id,
        target_seat_id: input.target_seat_id,
        reason: input.reason
      },
      ctx.userId!
    );
  }

  if (path === '/api/call-center/voicemails' && method === 'GET') {
    const ctx = requireOperator(headers);
    return listVoicemailsCommand(db, ctx.tenantId!, url.searchParams.get('status'));
  }

  if (path === '/api/call-center/voicemails/ingest' && method === 'POST') {
    return ingestVoicemailCommand(db, body as Record<string, unknown>);
  }

  if (path === '/api/call-center/supervisor/monitor' && method === 'POST') {
    const ctx = requireSupervisor(headers);
    const input = body as { call_session_id?: string; mode?: string };
    if (!input.call_session_id || !input.mode) {
      return { status: 400, data: { error: 'call_session_id and mode are required' } };
    }
    return supervisorMonitorCommand(db, ctx.tenantId!, ctx.userId!, input.call_session_id, input.mode);
  }

  const forceDisconnectMatch = path.match(/^\/api\/call-center\/supervisor\/calls\/([^/]+)\/disconnect$/);
  if (forceDisconnectMatch && method === 'POST') {
    const ctx = requireSupervisor(headers);
    const input = body as { seat_id?: string };
    return forceDisconnectCallCommand(
      db,
      ctx.tenantId!,
      forceDisconnectMatch[1],
      input.seat_id || null
    );
  }

  const parkMatch = path.match(/^\/api\/call-center\/calls\/([^/]+)\/park$/);
  if (parkMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    const input = body as { seat_id?: string; slot?: number };
    if (!input.seat_id) return { status: 400, data: { error: 'seat_id is required' } };
    new AgentSeatStore(db).assertSeatOwnership(ctx.tenantId!, input.seat_id);
    return parkCallCommand(db, ctx.tenantId!, parkMatch[1], input.seat_id, ctx.userId!, input.slot);
  }

  const pickupMatch = path.match(/^\/api\/call-center\/park\/(\d+)\/pickup$/);
  if (pickupMatch && method === 'POST') {
    const ctx = requireOperator(headers);
    const input = body as { seat_id?: string };
    if (!input.seat_id) return { status: 400, data: { error: 'seat_id is required' } };
    new AgentSeatStore(db).assertSeatOwnership(ctx.tenantId!, input.seat_id);
    return pickupParkedCallCommand(db, ctx.tenantId!, Number(pickupMatch[1]), input.seat_id, ctx.userId!);
  }

  const queuePriorityMatch = path.match(/^\/api\/call-center\/queues\/([^/]+)\/entries\/([^/]+)\/priority$/);
  if (queuePriorityMatch && method === 'PUT') {
    const ctx = requireSupervisor(headers);
    const input = body as { priority?: number };
    if (input.priority === undefined) return { status: 400, data: { error: 'priority is required' } };
    return adjustQueuePriorityCommand(
      db,
      ctx.tenantId!,
      queuePriorityMatch[1],
      queuePriorityMatch[2],
      Number(input.priority)
    );
  }

  return undefined;
}
