#!/usr/bin/env npx tsx
/**
 * Seed and publish the M1 RustPBX integration IVR flow (same graph as FEW_SHOT_M1).
 *
 * Usage:
 *   npx tsx scripts/seed-ivr-m1-flow.ts [tenantId] [--db path]
 *   npx tsx scripts/seed-ivr-m1-flow.ts --help
 *
 * Uses DATABASE_URL (Postgres) when set — same as production server.ts.
 * Falls back to SQLite via --db / OPC_DB_PATH for local dev.
 */
import { createDatabase } from '../src/db.js';
import { initPostgres, runMigrations } from '../src/db-pg.js';
import { PgSyncDatabase } from '../src/db-pg-sync.js';
import { IvrFlowStore } from '../src/agent-runtime/ivr/ivr-flow-store.js';
import { publishBlockingIssues } from '../src/agent-runtime/ivr/ivr-validation-policy.js';
import { validateFlowGraphDetailed } from '../src/agent-runtime/ivr/ivr-types.js';
import { M1_SEED_GRAPH } from '../src/agent-runtime/ivr/ivr-generator-seeds.js';
import { completeFlowMissingEdges } from '../src/agent-runtime/ivr/ivr-complete-menu-edges.js';

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/seed-ivr-m1-flow.ts [tenantId] [--db path]

  tenantId  Tenant to seed (default: default-tenant)
  --db      SQLite path when DATABASE_URL unset (default: OPC_DB_PATH or data/opc.db)
`);
}

function parseArgs(argv: string[]): { tenantId: string; dbPath: string; help: boolean } {
  let tenantId = 'default-tenant';
  let dbPath = process.env.OPC_DB_PATH || 'data/opc.db';
  let help = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--db' && argv[i + 1]) {
      dbPath = argv[++i];
    } else if (!arg.startsWith('-')) {
      tenantId = arg;
    }
  }

  return { tenantId, dbPath, help };
}

async function openDatabase(dbPath: string): Promise<{ db: unknown; close: () => void }> {
  if (process.env.DATABASE_URL) {
    const pg = await initPostgres();
    if (!pg) {
      throw new Error('cannot connect to Postgres (DATABASE_URL)');
    }
    await runMigrations(pg);
    const db = new PgSyncDatabase();
    return { db, close: () => db.close() };
  }
  const db = createDatabase(dbPath);
  return { db, close: () => {} };
}

async function main(): Promise<void> {
  const { tenantId, dbPath, help } = parseArgs(process.argv);
  if (help) {
    printHelp();
    return;
  }

  const graph = completeFlowMissingEdges(M1_SEED_GRAPH).graph;
  const report = validateFlowGraphDetailed(graph);
  if (publishBlockingIssues(report).length > 0) {
    console.error('M1 seed not publish-ready', report);
    process.exit(1);
  }

  const { db, close } = await openDatabase(dbPath);
  try {
    const store = new IvrFlowStore(db);
    const flow = store.saveFlow(tenantId, 'ivr_m1_rustpbx', 'M1 RustPBX 联调', graph);
    store.publishFlow(tenantId, flow.id);
    console.log('Published M1 flow', flow.id, 'for tenant', tenantId);
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
