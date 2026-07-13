import { randomUUID } from 'node:crypto';

import { canonicalIvrPayloadHash } from './canonical.js';
import { IvrError } from './errors.js';
import type { IvrDependencyResolver, IvrFlowUnitOfWork } from './ports.js';
import type { IvrCompilationReport } from './validation.js';
import { compileIvrGraph } from './validation.js';
import type { IvrFlow, IvrFlowGraph, IvrFlowVersion } from './types.js';

export interface IvrFlowServiceOptions {
  unit_of_work: IvrFlowUnitOfWork;
  dependency_resolver?: IvrDependencyResolver;
  id?: (kind: string) => string;
  now?: () => Date;
}

interface FlowActorInput {
  tenant_id: string;
  actor: string;
}

export interface CreateIvrFlowInput extends FlowActorInput {
  name: string;
  graph: IvrFlowGraph;
  metadata?: Record<string, unknown>;
}

export interface UpdateIvrFlowDraftInput extends FlowActorInput {
  flow_id: string;
  expected_revision: number;
  name?: string;
  graph?: IvrFlowGraph;
  metadata?: Record<string, unknown>;
}

export interface PublishIvrFlowInput extends FlowActorInput {
  flow_id: string;
  expected_draft_revision: number;
  idempotency_key: string;
}

export interface RollbackIvrFlowInput extends PublishIvrFlowInput {
  source_version: number;
}

export interface IvrFlowReleaseResult {
  flow: IvrFlow;
  version: IvrFlowVersion;
  replayed: boolean;
}

export class IvrFlowService {
  readonly #unitOfWork: IvrFlowUnitOfWork;
  readonly #dependencyResolver: IvrDependencyResolver;
  readonly #id: (kind: string) => string;
  readonly #now: () => Date;

  constructor(options: IvrFlowServiceOptions) {
    this.#unitOfWork = options.unit_of_work;
    this.#dependencyResolver = options.dependency_resolver ?? { async validate() { return []; } };
    this.#id = options.id ?? (() => randomUUID());
    this.#now = options.now ?? (() => new Date());
  }

  async createFlow(input: CreateIvrFlowInput): Promise<IvrFlow> {
    const tenantId = identifier(input.tenant_id);
    const actor = identifier(input.actor);
    const report = compileDraft(input.graph);
    const now = this.#timestamp();
    const flow: IvrFlow = {
      id: this.#newId('ivr-flow'),
      tenant_id: tenantId,
      name: name(input.name),
      status: 'draft',
      draft_graph: report.normalized_graph,
      draft_revision: 1,
      current_published_version: null,
      metadata: safeMetadata(input.metadata ?? {}),
      created_by: actor,
      updated_by: actor,
      created_at: now,
      updated_at: now
    };
    return this.#unitOfWork.run(tenantId, ({ flows }) => flows.insertFlow(flow));
  }

  async updateDraft(input: UpdateIvrFlowDraftInput): Promise<IvrFlow> {
    const tenantId = identifier(input.tenant_id);
    const flowId = identifier(input.flow_id);
    return this.#unitOfWork.run(tenantId, async ({ flows }) => {
      const current = required(await flows.getFlow(tenantId, flowId, { for_update: true }));
      assertRevision(current.draft_revision, input.expected_revision);
      const graph = input.graph === undefined ? current.draft_graph : compileDraft(input.graph).normalized_graph;
      return flows.updateDraft({
        ...current,
        ...(input.name === undefined ? {} : { name: name(input.name) }),
        ...(input.metadata === undefined ? {} : { metadata: safeMetadata(input.metadata) }),
        draft_graph: graph,
        draft_revision: current.draft_revision + 1,
        updated_by: identifier(input.actor),
        updated_at: this.#timestamp()
      }, input.expected_revision);
    });
  }

  async validate(input: { tenant_id: string; flow_id: string }): Promise<IvrCompilationReport> {
    const tenantId = identifier(input.tenant_id);
    const flowId = identifier(input.flow_id);
    return this.#unitOfWork.run(tenantId, async ({ flows, dependencies }) => {
      const flow = required(await flows.getFlow(tenantId, flowId));
      return this.#compileRelease(tenantId, flowId, flow.draft_graph, dependencies);
    });
  }

  publish(input: PublishIvrFlowInput): Promise<IvrFlowReleaseResult> {
    return this.#release({ ...input, release_kind: 'publish', source_version: null });
  }

  rollback(input: RollbackIvrFlowInput): Promise<IvrFlowReleaseResult> {
    return this.#release({ ...input, release_kind: 'rollback', source_version: positiveVersion(input.source_version) });
  }

  async #release(input: PublishIvrFlowInput & {
    release_kind: IvrFlowVersion['release_kind'];
    source_version: number | null;
  }): Promise<IvrFlowReleaseResult> {
    const tenantId = identifier(input.tenant_id);
    const flowId = identifier(input.flow_id);
    const actor = identifier(input.actor);
    const key = idempotencyKey(input.idempotency_key);
    const payloadHash = canonicalIvrPayloadHash({
      flow_id: flowId,
      expected_draft_revision: positiveVersion(input.expected_draft_revision),
      release_kind: input.release_kind,
      source_version: input.source_version
    });
    return this.#unitOfWork.run(tenantId, async ({ flows, dependencies }) => {
      const replay = await flows.findVersionByPublicationKey(tenantId, key);
      if (replay) {
        if (replay.publication_payload_hash !== payloadHash || replay.flow_id !== flowId) {
          throw new IvrError({ code: 'idempotency_conflict', status: 409 });
        }
        return { flow: required(await flows.getFlow(tenantId, flowId)), version: replay, replayed: true };
      }

      const flow = required(await flows.getFlow(tenantId, flowId, { for_update: true }));
      assertRevision(flow.draft_revision, input.expected_draft_revision);
      const source = input.source_version === null
        ? null
        : required(await flows.getVersion(tenantId, flowId, input.source_version));
      const graph = source?.graph ?? flow.draft_graph;
      const report = await this.#compileRelease(tenantId, flowId, graph, dependencies);
      if (report.errors.length > 0) throw publishValidationError(report);
      const versions = await flows.listVersions(tenantId, flowId);
      const versionNumber = Math.max(0, ...versions.map((version) => version.version)) + 1;
      const now = this.#timestamp();
      const version: IvrFlowVersion = {
        id: this.#newId('ivr-flow-version'),
        tenant_id: tenantId,
        flow_id: flowId,
        version: versionNumber,
        schema_version: 1,
        graph: report.normalized_graph,
        graph_hash: report.graph_hash,
        dependencies: report.dependencies,
        release_kind: input.release_kind,
        source_version: input.source_version,
        publication_key: key,
        publication_payload_hash: payloadHash,
        release_metadata: input.source_version === null ? {} : { source_version: input.source_version },
        published_by: actor,
        published_at: now
      };
      const inserted = await flows.insertVersion(version);
      const publishedFlow = await flows.updatePublication({
        ...flow,
        status: 'published',
        current_published_version: inserted.version,
        updated_by: actor,
        updated_at: now
      }, input.expected_draft_revision);
      return { flow: publishedFlow, version: inserted, replayed: false };
    });
  }

  async #compileRelease(
    tenantId: string,
    flowId: string,
    graph: IvrFlowGraph,
    transactionResolver?: IvrDependencyResolver
  ): Promise<IvrCompilationReport> {
    const report = compileIvrGraph(graph);
    if (report.errors.length > 0) return report;
    const dependencyIssues = await (transactionResolver ?? this.#dependencyResolver).validate({
      tenant_id: tenantId,
      flow_id: flowId,
      dependencies: report.dependencies
    });
    return dependencyIssues.length === 0
      ? report
      : { ...report, errors: [...report.errors, ...dependencyIssues] };
  }

  #newId(kind: string): string {
    return identifier(this.#id(kind));
  }

  #timestamp(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new IvrError({ code: 'internal_error', status: 500 });
    }
    return value.toISOString();
  }
}

function compileDraft(graph: IvrFlowGraph): IvrCompilationReport {
  let report: IvrCompilationReport;
  try {
    report = compileIvrGraph(graph);
  } catch {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  if (report.errors.some((issue) => issue.code === 'sensitive_graph_value')) {
    throw new IvrError({ code: 'validation_failed', status: 422, details: { errors: report.errors } });
  }
  return report;
}

function publishValidationError(report: IvrCompilationReport): IvrError {
  return new IvrError({
    code: 'publish_validation_failed',
    status: 422,
    details: { errors: report.errors, warnings: report.warnings }
  });
}

function required<T>(value: T | null): T {
  if (value === null) throw new IvrError({ code: 'not_found', status: 404 });
  return value;
}

function assertRevision(current: number, expected: number): void {
  if (!Number.isInteger(expected) || current !== expected) {
    throw new IvrError({ code: 'revision_conflict', status: 409 });
  }
}

function identifier(value: unknown): string {
  if (typeof value !== 'string') throw new IvrError({ code: 'validation_failed', status: 422 });
  const output = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(output)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return output;
}

function name(value: unknown): string {
  if (typeof value !== 'string') throw new IvrError({ code: 'validation_failed', status: 422 });
  const output = value.trim();
  if (!output || output.length > 256 || /[\u0000-\u001f\u007f]/.test(output)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return output;
}

function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string') throw new IvrError({ code: 'validation_failed', status: 422 });
  const output = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,255}$/.test(output)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return output;
}

function positiveVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return Number(value);
}

function safeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > 16_384 || /authorization|password|private_key|access_token/i.test(serialized)) {
    throw new IvrError({ code: 'validation_failed', status: 422 });
  }
  return structuredClone(value) as Record<string, unknown>;
}
