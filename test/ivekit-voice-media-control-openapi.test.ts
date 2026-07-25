import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';

const document = parse(
  readFileSync('docs/api/ivekit-media-control-v1.openapi.yaml', 'utf8')
) as Record<string, any>;

describe('iveKit media control OpenAPI contract', () => {
  it('publishes every Goal 1 endpoint and both production security schemes', () => {
    assert.equal(document.openapi, '3.1.0');
    assert.deepEqual(Object.keys(document.paths).sort(), [
      '/livez',
      '/metrics',
      '/readyz',
      '/v1/commands',
      '/v1/reconcile',
      '/v1/sessions/{reservation_id}'
    ]);
    assert.deepEqual(document.security, [{
      mutualTLS: [],
      bearerAuth: []
    }]);
    assert.equal(
      document.components.securitySchemes.mutualTLS.type,
      'mutualTLS'
    );
    assert.equal(
      document.components.securitySchemes.bearerAuth.scheme,
      'bearer'
    );
    assert.deepEqual(document.paths['/livez'].get.security, [{
      mutualTLS: []
    }]);
  });

  it('fixes protocol version, lifecycle actions, owner epoch and size bounds', () => {
    const schemas = document.components.schemas;
    assert.equal(
      schemas.ProtocolVersion.const,
      'ivekit.media-control.v1'
    );
    assert.deepEqual(schemas.Command.properties.action.enum, [
      'prepare',
      'commit',
      'cancel',
      'close'
    ]);
    assert.equal(schemas.OwnerEpoch.pattern, '^(0|[1-9][0-9]{0,19})$');
    assert.equal(schemas.Identifier.maxLength, 256);
    assert.equal(schemas.Session.properties.effective_sdp.maxLength, 16_384);
    assert.equal(schemas.Command.additionalProperties, false);
    assert.equal(
      schemas.Command.allOf[0].then.properties.payload
        .properties.offer_sdp.maxLength,
      16_384
    );
    assert.deepEqual(
      schemas.Command.allOf[0].then.properties.payload.required,
      ['offer_sdp', 'media_profile_id']
    );
    assert.equal(document['x-ivekit-limits'].payload_bytes, 131_072);
  });

  it('documents unknown outcomes and reconciliation as first-class behavior', () => {
    assert.ok(
      document.info.description.includes('unknown') &&
      document.info.description.includes('reconciled')
    );
    assert.deepEqual(
      document.components.schemas.Result.properties.state.enum,
      ['succeeded', 'failed', 'unknown']
    );
    assert.equal(
      document.components.schemas.Reconcile.properties.action.const,
      'reconcile'
    );
    assert.equal(
      document.components.schemas.Result.oneOf[2].properties.retryable.const,
      true
    );
    assert.equal(
      document.paths['/readyz'].get.responses['503'].content
        ['application/json'].schema.$ref,
      '#/components/schemas/Health'
    );
  });
});
