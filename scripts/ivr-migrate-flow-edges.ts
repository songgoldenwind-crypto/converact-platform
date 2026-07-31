#!/usr/bin/env npx tsx
import { resolveBrandEnv } from '../src/config/converact-env.js';
/**
 * 不一致-6 §6-MIG — scan published IVR flows; dry-run CSV + optional menu edge auto-fix.
 *
 * Usage:
 *   npx tsx scripts/ivr-migrate-flow-edges.ts [--db path] [--apply]
 */
import { createDatabase, all } from '../src/db.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { validateFlowGraphDetailed } from '../src/agent-runtime/ivr/ivr-types.js';
import { completeFlowMissingEdges } from '../src/agent-runtime/ivr/ivr-complete-menu-edges.js';

function parseArgs(argv: string[]): { dbPath: string; apply: boolean } {
  let dbPath = resolveBrandEnv(process.env, 'DB_PATH') || 'data/opc.db';
  let apply = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--apply') apply = true;
    else if (argv[i] === '--db' && argv[i + 1]) {
      dbPath = argv[++i];
    }
  }
  return { dbPath, apply };
}

function main() {
  const { dbPath, apply } = parseArgs(process.argv);
  const db = createDatabase(dbPath);
  const store = new IvrFlowStore(db);
  const tenantRows = all(
    db,
    `SELECT DISTINCT tenant_id FROM voice_agent_specs WHERE nodes IS NOT NULL AND nodes != ''`,
    []
  ) as Array<{ tenant_id: string }>;

  const published = tenantRows.flatMap((row) =>
    store.listFlows(row.tenant_id).filter((f) => f.status === 'published')
  );
  console.log('flow_id,tenant_id,nodeId,handle,severity,message');

  let fixed = 0;
  for (const flow of published) {
    const report = validateFlowGraphDetailed(flow.graph);
    const issues = [...report.errors, ...report.warnings];
    for (const issue of issues) {
      console.log(
        [
          flow.id,
          flow.tenant_id,
          issue.nodeId ?? '',
          issue.handle ?? '',
          report.errors.includes(issue) ? 'error' : 'warning',
          JSON.stringify(issue.message),
        ].join(',')
      );
    }

    if (!apply || issues.length === 0) continue;

    const repaired = completeFlowMissingEdges(flow.graph).graph;
    const after = validateFlowGraphDetailed(repaired);
    if (after.errors.length > 0 || after.warnings.length > 0) continue;

    store.saveFlow(flow.tenant_id, flow.id, flow.name, repaired);
    store.publishFlow(flow.tenant_id, flow.id);
    fixed++;
  }

  console.error(`scanned=${published.length} apply=${apply} auto_fixed=${fixed}`);
}

main();
