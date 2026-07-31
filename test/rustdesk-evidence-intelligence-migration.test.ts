import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  'src/migrations/076_rustdesk_evidence_intelligence_reconciliation.sql',
  'utf8'
);

test('RustDesk evidence reconciliation discovery is least-privilege and bounded', () => {
  assert.match(migration, /opc_rustdesk_evidence_intelligence_candidates/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.match(migration, /SET search_path = pg_catalog, public/);
  assert.match(migration, /file\.status = 'ready'/);
  assert.match(migration, /file\.threat_status = 'clean'/);
  assert.match(migration, /rustdesk_companion_evidence/);
  assert.match(migration, /NOT EXISTS[\s\S]*collaboration_message_attachments/);
  assert.match(migration, /rustdesk_intelligence_reconciliation/);
  assert.match(migration, /LIMIT GREATEST\(1, LEAST\(p_limit, 100\)\)/);
  assert.match(migration, /REVOKE ALL[\s\S]*FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO opc_runtime/);
  assert.doesNotMatch(migration, /SELECT\s+file\.\*/i);
});
