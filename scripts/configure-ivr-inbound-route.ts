#!/usr/bin/env npx tsx
import { resolveBrandEnv } from '../src/config/converact-env.js';
/**
 * Point tenant inbound DIDs at an IVR flow (M1 RustPBX联调).
 *
 * Usage:
 *   npx tsx scripts/configure-ivr-inbound-route.ts [tenantId] [flowId] [--did +4000]
 *   npx tsx scripts/configure-ivr-inbound-route.ts --help
 */
import { createDatabase } from '../src/db.js';
import { initPostgres, runMigrations } from '../src/db-pg.js';
import { PgSyncDatabase } from '../src/db-pg-sync.js';
import { DidStore } from '../src/agent-runtime/call-center/inbound/did-store.js';
import { AutoAttendantService } from '../src/agent-runtime/call-center/inbound/auto-attendant.js';

function printHelp(): void {
  console.log(`Usage: npx tsx scripts/configure-ivr-inbound-route.ts [tenantId] [flowId] [--did NUMBER]

  tenantId  Tenant (default: first tenant in DB)
  flowId    IVR flow id (default: ivr_m1_rustpbx)
  --did     Also create/update this DID (min 8 digits, e.g. 40000001)
`);
}

function parseArgs(argv: string[]): {
  tenantId: string | null;
  flowId: string;
  extraDid: string | null;
  help: boolean;
} {
  let tenantId: string | null = null;
  let flowId = 'ivr_m1_rustpbx';
  let extraDid: string | null = null;
  let help = false;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--did' && argv[i + 1]) {
      extraDid = argv[++i];
    } else if (!arg.startsWith('-')) {
      if (!tenantId) tenantId = arg;
      else flowId = arg;
    }
  }

  return { tenantId, flowId, extraDid, help };
}

async function openDatabase(dbPath: string): Promise<{ db: unknown; close: () => void }> {
  if (process.env.DATABASE_URL) {
    const pg = await initPostgres();
    if (!pg) throw new Error('cannot connect to Postgres (DATABASE_URL)');
    await runMigrations(pg);
    const db = new PgSyncDatabase();
    return { db, close: () => db.close() };
  }
  const db = createDatabase(dbPath);
  return { db, close: () => {} };
}

async function main(): Promise<void> {
  const { tenantId: argTenant, flowId, extraDid, help } = parseArgs(process.argv);
  if (help) {
    printHelp();
    return;
  }

  const dbPath = resolveBrandEnv(process.env, 'DB_PATH') || 'data/opc.db';
  const { db, close } = await openDatabase(dbPath);
  try {
    const { one } = await import('../src/db.js');
    const tenantId =
      argTenant ||
      (one(db, 'SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1')?.id as string | undefined);
    if (!tenantId) {
      console.error('No tenant found');
      process.exit(1);
    }

    new AutoAttendantService(db).upsertConfig(tenantId, {
      business_hours: {
        sun: [0, 24],
        mon: [0, 24],
        tue: [0, 24],
        wed: [0, 24],
        thu: [0, 24],
        fri: [0, 24],
        sat: [0, 24],
      },
    });

    const didStore = new DidStore(db);
    const updated: string[] = [];

    for (const did of didStore.listDids(tenantId)) {
      didStore.updateDid(did.id, tenantId, {
        route_type: 'ivr',
        route_target: flowId,
        label: did.label || 'IVR M1',
      });
      updated.push(did.number);
    }

    if (extraDid) {
      const normalized = extraDid;
      const existing = didStore.findByNumber(normalized);
      if (existing && existing.tenant_id === tenantId) {
        didStore.updateDid(existing.id, tenantId, {
          route_type: 'ivr',
          route_target: flowId,
          label: 'IVR lab DID',
        });
        updated.push(existing.number);
      } else if (!existing) {
        const created = didStore.createDid({
          tenant_id: tenantId,
          number: normalized,
          label: 'IVR lab DID',
          route_type: 'ivr',
          route_target: flowId,
        });
        updated.push(created.number);
      }
    }

    console.log('IVR inbound routing configured', {
      tenantId,
      flowId,
      dids: updated,
    });
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
