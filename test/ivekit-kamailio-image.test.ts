import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('iveKit Kamailio image is source-pinned, multi-arch buildable and non-root', async () => {
  const [dockerfile, build, readme] = await Promise.all([
    source('infra/ivekit/kamailio/Dockerfile'),
    source('infra/ivekit/kamailio/build.sh'),
    source('infra/ivekit/kamailio/README.md')
  ]);

  assert.match(dockerfile, /ARG KAMAILIO_VERSION=6\.0\.7/);
  assert.match(dockerfile, /c4b5c17abba18d5378108df7138177caae33de7d54ead8c9ee1e28650b20d6b5/);
  for (const module of [
    'dispatcher', 'dialog', 'htable', 'tls', 'websocket', 'xhttp_prom'
  ]) assert.match(dockerfile, new RegExp(`include_modules=.*${module}`));
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /HEALTHCHECK NONE/);
  assert.doesNotMatch(dockerfile, /sqlite|apt-get install[^\n]*kamailio/i);
  assert.match(build, /docker buildx build/);
  assert.match(build, /IVEKIT_KAMAILIO_IMAGE/);
  assert.match(readme, /kamailio\/kamailio@6\.0\.7/);
  assert.match(readme, /kamailio -c/);
});

test('Kamailio syntax verifier requires an immutable image and disables networking', async () => {
  const verifier = await source('scripts/verify-kamailio-config.sh');
  assert.match(verifier, /@sha256:/);
  assert.match(verifier, /--network none/);
  assert.match(verifier, /--read-only/);
  assert.match(verifier, /--cap-drop ALL/);
  assert.match(verifier, /kamailio -c -f/);
});

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}
