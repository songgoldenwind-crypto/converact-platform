import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCapacityEvidenceObjectUri } from '../scripts/capacity/orchestrator/s3-evidence.js';

test('capacity evidence reader accepts only a bounded key in its configured bucket', () => {
  assert.equal(
    parseCapacityEvidenceObjectUri(
      's3://capacity-evidence/capacity/run-1/evidence.json',
      'capacity-evidence'
    ),
    'capacity/run-1/evidence.json'
  );
  assert.throws(
    () => parseCapacityEvidenceObjectUri('s3://other-bucket/capacity/run-1.json', 'capacity-evidence'),
    /bucket/i
  );
  assert.throws(
    () => parseCapacityEvidenceObjectUri('https://capacity-evidence/run-1.json', 'capacity-evidence'),
    /URI/i
  );
  assert.throws(
    () => parseCapacityEvidenceObjectUri('s3://capacity-evidence/a/../secret', 'capacity-evidence'),
    /URI|key/i
  );
});
