import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { readJsonRequest } from '../src/http.js';

test('HTTP JSON parser accepts DELETE request bodies', async () => {
  const request = Readable.from([Buffer.from('{"actor_identity":"agent_delete"}')]) as Readable & {
    method: string;
  };
  request.method = 'DELETE';

  assert.deepEqual(await readJsonRequest(request), {
    actor_identity: 'agent_delete'
  });
});
