import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('stage 2 deployment gate renders Compose and Helm with immutable images', () => {
  const script = readFileSync('scripts/verify-ivekit-stage2-deployment.sh', 'utf8');
  const workflow = readFileSync('.github/workflows/ivekit-stage2-ci.yml', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts['verify:ivekit:stage2-deployment'],
    'sh scripts/verify-ivekit-stage2-deployment.sh'
  );
  assert.match(script, /docker compose[\s\S]*config --quiet/);
  assert.match(script, /helm lint/);
  assert.match(script, /helm template/);
  assert.match(script, /image\.digest=sha256:/);
  assert.match(script, /opc:\n[\s\S]*?digest: sha256:d{64}/);
  assert.match(script, /aiAgent:\n[\s\S]*?digest: sha256:e{64}/);
  assert.match(script, /frontend:\n[\s\S]*?digest: sha256:f{64}/);
  assert.match(script, /postgres:\n[\s\S]*?digest: sha256:1{64}/);
  assert.match(script, /redis:\n[\s\S]*?digest: sha256:2{64}/);
  assert.match(script, /nats:\n[\s\S]*?digest: sha256:3{64}/);
  assert.match(script, /livekit:\n[\s\S]*?digest: sha256:4{64}/);
  assert.match(script, /sip:\n[\s\S]*?digest: sha256:5{64}/);
  assert.match(script, /rustdesk:\n[\s\S]*?digest: sha256:6{64}/);
  assert.match(script, /registry\.example\.invalid\/opc\/platform@sha256:/);
  assert.match(script, /registry\.example\.invalid\/opc\/ai-agent@sha256:/);
  assert.match(script, /registry\.example\.invalid\/opc\/frontend@sha256:/);
  assert.match(script, /postgres@sha256:1{64}/);
  assert.match(script, /redis@sha256:2{64}/);
  assert.match(script, /nats@sha256:3{64}/);
  assert.match(script, /livekit\/livekit-server@sha256:4{64}/);
  assert.match(script, /livekit\/sip@sha256:5{64}/);
  assert.match(script, /rustdesk\/rustdesk-server@sha256:6{64}/);
  assert.match(script, /bundled infrastructure unexpectedly rendered without immutable digest/);
  assert.match(script, /clamav\.image\.digest=sha256:/);
  assert.match(script, /livekit\.redis\.address=redis\.shared\.example\.invalid:6379/);
  assert.match(script, /media\.egress\.image\.repository=ivekit\/livekit-egress/);
  assert.match(
    script,
    /media\.egress\.image\.repository=registry\.example\.invalid\/ivekit\/livekit-egress/
  );
  assert.match(
    script,
    /media\.egress\.image\.allowedRegistries\[0\]=registry\.example\.invalid/
  );
  assert.match(script, /docker\.io\/livekit\/egress/);
  assert.match(
    script,
    /media\.egress\.image\.repository="\$unapproved_egress_repository"/
  );
  assert.match(script, /media\.egress\.image\.digest=sha256:/);
  assert.match(script, /docker\.io\/livekit\/egress/);
  assert.match(script, /registry-1\.docker\.io\/livekit\/egress/);
  assert.match(script, /untrusted\.example\.invalid\/ivekit\/livekit-egress/);
  assert.match(script, /unapproved Egress image repository unexpectedly rendered/);
  assert.match(script, /external Egress unexpectedly rendered without shared Redis/);
  assert.match(script, /external Egress unexpectedly rendered without a custom image digest/);
  assert.match(script, /IVEKIT_EGRESS_POOL_NAME/);
  assert.match(script, /test\/livekit-deployment-preflight\.test\.ts/);
  assert.match(script, /test\/ivekit-stage2-release-evidence\.test\.ts/);
  assert.match(workflow, /azure\/setup-helm@v5\.0\.0/);
  assert.match(workflow, /version: v3\.18\.4/);
  assert.match(workflow, /npm run verify:ivekit:stage2-deployment/);
});
