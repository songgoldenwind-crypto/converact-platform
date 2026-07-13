import { randomUUID } from 'node:crypto';

import { ContactCenterError } from './errors.js';
import type {
  ContactCenterSupervisorControlPort,
  ContactCenterUnitOfWork
} from './ports.js';
import { transitionSupervisorSession } from './state-machine.js';
import type {
  ContactCenterSupervisorMode,
  ContactCenterSupervisorSession
} from './types.js';

export interface ContactCenterSupervisorServiceOptions {
  unit_of_work: ContactCenterUnitOfWork;
  control: ContactCenterSupervisorControlPort;
  id?: () => string;
  now?: () => Date;
}

export class ContactCenterSupervisorService {
  readonly #unitOfWork: ContactCenterUnitOfWork;
  readonly #control: ContactCenterSupervisorControlPort;
  readonly #id: () => string;
  readonly #now: () => Date;

  constructor(options: ContactCenterSupervisorServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#control = options.control;
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async start(input: {
    tenant_id: string;
    call_id: string;
    target_agent_id: string;
    supervisor_identity: string;
    mode: ContactCenterSupervisorMode;
    authorization_ref: string;
    idempotency_key: string;
  }): Promise<ContactCenterSupervisorSession> {
    const request = {
      tenant_id: identifier(input.tenant_id, 'tenant_id'),
      call_id: identifier(input.call_id, 'call_id'),
      target_agent_id: identifier(input.target_agent_id, 'target_agent_id'),
      supervisor_identity: identifier(input.supervisor_identity, 'supervisor_identity'),
      mode: supervisorMode(input.mode),
      authorization_ref: requiredText(input.authorization_ref, 'authorization_ref', 2_000),
      idempotency_key: idempotency(input.idempotency_key)
    };
    const prepared = await this.#unitOfWork.run(request.tenant_id, async ({ repository }) => {
      const replay = await repository.findSupervisorByIdempotencyKey(
        request.tenant_id,
        request.idempotency_key
      );
      if (replay) {
        assertReplay(replay, request);
        return replay;
      }
      if (!this.#control.supports(request.mode)) throw unavailable(request.mode);
      if (!await repository.isAgentAssignedToCall(
        request.tenant_id,
        request.call_id,
        request.target_agent_id
      )) throw notFound('agent_call_assignment');

      const now = timestamp(this.#now(), 'now');
      const candidate: ContactCenterSupervisorSession = {
        id: identifier(this.#id(), 'session_id'),
        ...request,
        state: 'requested',
        provider_session_id: '',
        reason: '',
        requested_at: now,
        started_at: null,
        ended_at: null,
        revision: 1,
        created_at: now,
        updated_at: now
      };
      const inserted = await repository.insertSupervisorSession(candidate);
      if (inserted.id !== candidate.id) assertReplay(inserted, request);
      return inserted;
    });

    if (prepared.state !== 'requested') return prepared;
    if (!this.#control.supports(prepared.mode)) throw unavailable(prepared.mode);

    let providerSessionId: string;
    try {
      const result = await this.#control.start({
        session_id: prepared.id,
        tenant_id: prepared.tenant_id,
        call_id: prepared.call_id,
        target_agent_id: prepared.target_agent_id,
        supervisor_identity: prepared.supervisor_identity,
        mode: prepared.mode,
        authorization_ref: prepared.authorization_ref
      });
      providerSessionId = identifier(result.provider_session_id, 'provider_session_id');
    } catch (error) {
      const current = await this.#recordStartFailure(prepared, failureCode(error));
      if (current.state === 'active') return current;
      throw new ContactCenterError({
        code: 'conflict',
        status: 502,
        retryable: true,
        details: { reason: current.reason || 'supervisor_start_failed' }
      });
    }

    return this.#unitOfWork.run(prepared.tenant_id, async ({ repository }) => {
      const current = required(
        await repository.getSupervisorSession(
          prepared.tenant_id,
          prepared.id,
          { for_update: true }
        ),
        'supervisor_session'
      );
      if (current.state === 'active' || current.state === 'ended') return current;
      if (current.state !== 'requested') throw conflict('supervisor_session_not_startable');
      const now = timestamp(this.#now(), 'now');
      return repository.updateSupervisorSession({
        ...current,
        state: transitionSupervisorSession(current.state, 'authorize'),
        provider_session_id: providerSessionId,
        reason: '',
        started_at: now,
        updated_at: now
      }, current.revision);
    });
  }

  async end(input: {
    tenant_id: string;
    session_id: string;
    supervisor_identity: string;
    reason?: string;
  }): Promise<ContactCenterSupervisorSession> {
    const tenantId = identifier(input.tenant_id, 'tenant_id');
    const sessionId = identifier(input.session_id, 'session_id');
    const identity = identifier(input.supervisor_identity, 'supervisor_identity');
    const reason = input.reason === undefined
      ? 'ended'
      : requiredText(input.reason, 'reason', 256);
    const prepared = await this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const current = required(
        await repository.getSupervisorSession(tenantId, sessionId, { for_update: true }),
        'supervisor_session'
      );
      if (current.supervisor_identity !== identity) throw notFound('supervisor_session');
      if (current.state === 'ended') return current;
      if (current.state !== 'active' || !current.provider_session_id) {
        throw conflict('supervisor_session_not_active');
      }
      return current;
    });
    if (prepared.state === 'ended') return prepared;

    await this.#control.end({
      tenant_id: tenantId,
      provider_session_id: prepared.provider_session_id,
      idempotency_key: `${prepared.id}:end`
    });

    return this.#unitOfWork.run(tenantId, async ({ repository }) => {
      const current = required(
        await repository.getSupervisorSession(tenantId, sessionId, { for_update: true }),
        'supervisor_session'
      );
      if (current.state === 'ended') return current;
      if (current.state !== 'active') throw conflict('supervisor_session_not_active');
      const now = timestamp(this.#now(), 'now');
      return repository.updateSupervisorSession({
        ...current,
        state: transitionSupervisorSession(current.state, 'end'),
        reason,
        ended_at: now,
        updated_at: now
      }, current.revision);
    });
  }

  #recordStartFailure(
    session: ContactCenterSupervisorSession,
    reason: string
  ): Promise<ContactCenterSupervisorSession> {
    return this.#unitOfWork.run(session.tenant_id, async ({ repository }) => {
      const current = required(
        await repository.getSupervisorSession(
          session.tenant_id,
          session.id,
          { for_update: true }
        ),
        'supervisor_session'
      );
      if (current.state !== 'requested') return current;
      const now = timestamp(this.#now(), 'now');
      return repository.updateSupervisorSession({
        ...current,
        state: transitionSupervisorSession(current.state, 'fail'),
        reason,
        ended_at: now,
        updated_at: now
      }, current.revision);
    });
  }
}

function assertReplay(
  session: ContactCenterSupervisorSession,
  expected: {
    call_id: string;
    target_agent_id: string;
    supervisor_identity: string;
    mode: ContactCenterSupervisorMode;
    authorization_ref: string;
  }
): void {
  if (session.call_id !== expected.call_id ||
    session.target_agent_id !== expected.target_agent_id ||
    session.supervisor_identity !== expected.supervisor_identity ||
    session.mode !== expected.mode ||
    session.authorization_ref !== expected.authorization_ref) {
    throw new ContactCenterError({ code: 'idempotency_conflict', status: 409 });
  }
}

function required<T>(value: T | null, resource: string): T {
  if (!value) throw notFound(resource);
  return value;
}

function unavailable(mode: ContactCenterSupervisorMode): ContactCenterError {
  return new ContactCenterError({
    code: 'capability_unavailable',
    status: 501,
    details: { capability: `contact_center.supervisor.${mode}` }
  });
}

function notFound(resource: string): ContactCenterError {
  return new ContactCenterError({ code: 'not_found', status: 404, details: { resource } });
}

function conflict(reason: string): ContactCenterError {
  return new ContactCenterError({ code: 'conflict', status: 409, details: { reason } });
}

function identifier(value: unknown, field: string): string {
  const output = String(value ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/.test(output)) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field }
    });
  }
  return output;
}

function idempotency(value: unknown): string {
  const output = String(value ?? '').trim();
  if (!/^[\x21-\x7e]{1,200}$/.test(output)) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field: 'idempotency_key' }
    });
  }
  return output;
}

function requiredText(value: unknown, field: string, maximum: number): string {
  const output = typeof value === 'string' ? value.trim() : '';
  if (!output || output.length > maximum || /[\u0000-\u001f\u007f]/.test(output)) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field }
    });
  }
  return output;
}

function supervisorMode(value: unknown): ContactCenterSupervisorMode {
  if (value !== 'monitor' && value !== 'whisper' && value !== 'barge') {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field: 'mode' }
    });
  }
  return value;
}

function timestamp(value: Date, field: string): string {
  if (Number.isNaN(value.getTime())) {
    throw new ContactCenterError({
      code: 'validation_failed', status: 422, details: { field }
    });
  }
  return value.toISOString();
}

function failureCode(error: unknown): string {
  const code = error && typeof error === 'object'
    ? String((error as { code?: unknown }).code || '')
    : '';
  return /^[a-z][a-z0-9_]{0,127}$/.test(code) ? code : 'supervisor_start_failed';
}
