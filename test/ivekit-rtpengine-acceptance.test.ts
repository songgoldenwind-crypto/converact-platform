import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';

import {
  RtpStreamCollector,
  buildEndpointSdp,
  buildPcmuRtpPacket,
  buildRtcpSenderReport,
  createSdesKeyMaterial,
  createSdesSrtpContext,
  openRtpMediaEndpoint,
  parseRelayEndpoint,
  parseRtcpPacket,
  parseRtpPacket,
  parseSdesCrypto,
  protectSrtpPacket,
  unprotectSrtpPacket
} from '../scripts/capacity/generators/rtpengine-media.js';
import {
  RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS,
  buildRtpengineAcceptanceEvidence,
  createRtpengineAcceptanceCommand,
  runRtpengineControlMatrix,
  runRtpengineMediaScenario,
  type RtpengineAcceptanceAdmissionIdentity,
  type RtpengineAcceptanceAdmissionPort
} from '../scripts/ivekit-rtpengine-acceptance.js';
import { mediaControlPayloadHash } from '../src/agent-runtime/converact/media-control/protocol.js';
import {
  prepareIsolatedRtpengineEnvironment,
  loadRtpengineAcceptanceCliConfig
} from '../scripts/ivekit-rtpengine-acceptance-cli.js';

describe('iveKit RTPengine media generator', () => {
  it('ships the signalling templates referenced by media-control profiles', () => {
    const configuration = readFileSync(
      'infra/converact/rtpengine/rtpengine.conf.template',
      'utf8'
    );

    assert.match(configuration, /^templates=ivekit-signalling-templates$/m);
    assert.match(configuration, /^\[ivekit-signalling-templates\]$/m);
    assert.match(configuration, /^g711-relay-v1\s*=/m);
    assert.match(
      configuration,
      /SDES=only-AES_CM_128_HMAC_SHA1_80/
    );
    assert.match(configuration, /rtcp-mux=\[accept offer\]/);
  });

  it('builds and parses timestamped PCMU RTP packets without a sound device', () => {
    const payload = Buffer.alloc(160, 0x7f);
    const packet = buildPcmuRtpPacket({
      sequence: 65_534,
      timestamp: 0xffff_ff00,
      ssrc: 0x1234_5678,
      payload
    });

    const parsed = parseRtpPacket(packet);

    assert.equal(parsed.version, 2);
    assert.equal(parsed.payload_type, 0);
    assert.equal(parsed.sequence, 65_534);
    assert.equal(parsed.timestamp, 0xffff_ff00);
    assert.equal(parsed.ssrc, 0x1234_5678);
    assert.deepEqual(parsed.payload, payload);
  });

  it('measures loss, ordering, duplicates, first packet time, and RFC 3550 jitter', () => {
    const collector = new RtpStreamCollector({
      clock_rate_hz: 8_000,
      expected_payload_type: 0,
      expected_ssrc: 0x0102_0304
    });
    const make = (sequence: number, timestamp: number) => buildPcmuRtpPacket({
      sequence,
      timestamp,
      ssrc: 0x0102_0304,
      payload: Buffer.alloc(160, sequence & 0xff)
    });

    collector.observe(make(100, 0), 1_000);
    collector.observe(make(101, 160), 1_020);
    collector.observe(make(103, 480), 1_065);
    collector.observe(make(103, 480), 1_066);
    collector.observe(make(102, 320), 1_067);

    const evidence = collector.snapshot({
      expected_packets: 5,
      started_at_ms: 990
    });
    assert.equal(evidence.received_packets, 5);
    assert.equal(evidence.unique_packets, 4);
    assert.equal(evidence.lost_packets, 1);
    assert.equal(evidence.duplicate_packets, 1);
    assert.equal(evidence.out_of_order_packets, 1);
    assert.equal(evidence.first_packet_ms, 10);
    assert.ok(evidence.jitter_ms > 0);
  });

  it('builds an RTCP sender report with the matching SSRC and counters', () => {
    const packet = buildRtcpSenderReport({
      ssrc: 0x1020_3040,
      ntp_seconds: 2_208_988_900,
      ntp_fraction: 0x0102_0304,
      rtp_timestamp: 9_600,
      packet_count: 60,
      octet_count: 9_600
    });

    assert.deepEqual(parseRtcpPacket(packet), {
      version: 2,
      packet_type: 200,
      report_count: 0,
      ssrc: 0x1020_3040,
      packet_count: 60,
      octet_count: 9_600
    });
  });

  it('extracts the advertised relay endpoint from media-level SDP', () => {
    const sdp = [
      'v=0',
      'o=- 1 1 IN IP4 10.0.0.1',
      's=ivekit',
      'c=IN IP4 198.51.100.10',
      't=0 0',
      'm=audio 24560 RTP/AVP 0',
      'c=IN IP4 203.0.113.44',
      'a=rtpmap:0 PCMU/8000',
      ''
    ].join('\r\n');

    assert.deepEqual(parseRelayEndpoint(sdp), {
      address: '203.0.113.44',
      port: 24_560,
      profile: 'RTP/AVP',
      payload_types: [0]
    });
  });

  it('builds and parses an SDES-SRTP endpoint SDP with bounded key material', () => {
    const keyMaterial = createSdesKeyMaterial(
      Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      Buffer.from('0f0e0d0c0b0a0908070605040302', 'hex')
    );
    const sdp = buildEndpointSdp({
      address: '127.0.0.1',
      port: 24_000,
      session_id: '12345',
      ssrc: 0x0102_0304,
      mode: 'sdes_srtp',
      key_material: keyMaterial
    });

    assert.match(sdp, /m=audio 24000 RTP\/SAVP 0/);
    assert.match(sdp, /a=rtcp-mux/);
    assert.deepEqual(parseSdesCrypto(sdp), keyMaterial);
  });

  it('round-trips AES_CM_128_HMAC_SHA1_80 SRTP without exposing plaintext', () => {
    const masterKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const masterSalt = Buffer.from('0f0e0d0c0b0a0908070605040302', 'hex');
    const context = createSdesSrtpContext({
      suite: 'AES_CM_128_HMAC_SHA1_80',
      master_key: masterKey,
      master_salt: masterSalt,
      ssrc: 0xdecafbad
    });
    const plaintext = buildPcmuRtpPacket({
      sequence: 34_567,
      timestamp: 0x1020_3040,
      ssrc: 0xdecafbad,
      payload: Buffer.from('ivekit-plaintext-payload'.padEnd(160, '.'), 'ascii')
    });

    const protectedPacket = protectSrtpPacket(context, plaintext);

    assert.equal(
      protectedPacket.includes(Buffer.from('ivekit-plaintext-payload', 'ascii')),
      false
    );
    assert.deepEqual(unprotectSrtpPacket(context, protectedPacket), plaintext);
  });

  it('derives the RFC 3711 AES-CM session key material', () => {
    const context = createSdesSrtpContext({
      suite: 'AES_CM_128_HMAC_SHA1_80',
      master_key: Buffer.from(
        'e1f97a0d3e018be0d64fa32c06de4139',
        'hex'
      ),
      master_salt: Buffer.from('0ec675ad498afeebb6960b3aabe6', 'hex'),
      ssrc: 0xcafebabe
    });

    assert.equal(
      context.encryption_key.toString('hex'),
      'c61e7a93744f39ee10734afe3ff7a087'
    );
    assert.equal(
      context.authentication_key.toString('hex'),
      'cebe321f6ff7716b6fd4ab49af256a156d38baa4'
    );
    assert.equal(
      context.session_salt.toString('hex'),
      '30cbbc08863d8c85d49db34a9ae1'
    );
  });

  it('sends bounded bidirectional PCMU RTP and RTCP over real UDP sockets', async () => {
    const endpointA = await openRtpMediaEndpoint({
      bind_address: '127.0.0.1',
      ssrc: 0x1111_1111,
      expected_remote_ssrc: 0x2222_2222,
      maximum_packets: 32
    });
    const endpointB = await openRtpMediaEndpoint({
      bind_address: '127.0.0.1',
      ssrc: 0x2222_2222,
      expected_remote_ssrc: 0x1111_1111,
      maximum_packets: 32
    });

    try {
      const [sentA, sentB] = await Promise.all([
        endpointA.sendPcmu({
          target: endpointB.localEndpoint(),
          packet_count: 8,
          packet_interval_ms: 1,
          payload_seed: 0x31
        }),
        endpointB.sendPcmu({
          target: endpointA.localEndpoint(),
          packet_count: 8,
          packet_interval_ms: 1,
          payload_seed: 0x72
        })
      ]);
      await Promise.all([
        endpointA.sendRtcp(endpointB.localEndpoint()),
        endpointB.sendRtcp(endpointA.localEndpoint())
      ]);
      await Promise.all([
        endpointA.waitFor({ rtp_packets: 8, rtcp_packets: 1, timeout_ms: 1_000 }),
        endpointB.waitFor({ rtp_packets: 8, rtcp_packets: 1, timeout_ms: 1_000 })
      ]);

      assert.equal(sentA.rtp_packets, 8);
      assert.equal(sentB.rtp_packets, 8);
      assert.equal(endpointA.snapshot({ expected_packets: 8 }).unique_packets, 8);
      assert.equal(endpointB.snapshot({ expected_packets: 8 }).unique_packets, 8);
      assert.equal(endpointA.snapshot({ expected_packets: 8 }).rtcp_packets, 1);
      assert.equal(endpointB.snapshot({ expected_packets: 8 }).rtcp_packets, 1);
    } finally {
      await Promise.all([endpointA.close(), endpointB.close()]);
    }
  });

  it('sends authenticated SDES-SRTP over real UDP without plaintext on wire', async () => {
    const keyA = createSdesKeyMaterial(
      Buffer.alloc(16, 0x11),
      Buffer.alloc(14, 0x22)
    );
    const keyB = createSdesKeyMaterial(
      Buffer.alloc(16, 0x33),
      Buffer.alloc(14, 0x44)
    );
    const endpointA = await openRtpMediaEndpoint({
      bind_address: '127.0.0.1',
      ssrc: 0x3333_3333,
      expected_remote_ssrc: 0x4444_4444,
      maximum_packets: 32
    });
    const endpointB = await openRtpMediaEndpoint({
      bind_address: '127.0.0.1',
      ssrc: 0x4444_4444,
      expected_remote_ssrc: 0x3333_3333,
      maximum_packets: 32
    });
    try {
      endpointA.configureSrtp({
        send_key_material: keyA,
        receive_key_material: keyB
      });
      endpointB.configureSrtp({
        send_key_material: keyB,
        receive_key_material: keyA
      });
      await Promise.all([
        endpointA.sendPcmu({
          target: endpointB.localEndpoint(),
          packet_count: 8,
          packet_interval_ms: 1,
          payload_seed: 0x51
        }),
        endpointB.sendPcmu({
          target: endpointA.localEndpoint(),
          packet_count: 8,
          packet_interval_ms: 1,
          payload_seed: 0x61
        })
      ]);
      await Promise.all([
        endpointA.waitFor({ rtp_packets: 8, rtcp_packets: 0, timeout_ms: 1_000 }),
        endpointB.waitFor({ rtp_packets: 8, rtcp_packets: 0, timeout_ms: 1_000 })
      ]);

      const evidenceA = endpointA.snapshot({ expected_packets: 8 });
      const evidenceB = endpointB.snapshot({ expected_packets: 8 });
      assert.equal(evidenceA.unique_packets, 8);
      assert.equal(evidenceB.unique_packets, 8);
      assert.equal(evidenceA.wire_plaintext_match_packets, 0);
      assert.equal(evidenceB.wire_plaintext_match_packets, 0);
      assert.equal(evidenceA.invalid_packets, 0);
      assert.equal(evidenceB.invalid_packets, 0);
    } finally {
      await Promise.all([endpointA.close(), endpointB.close()]);
    }
  });
});

describe('iveKit RTPengine real acceptance evidence', () => {
  const identity = {
    source_commit: 'a'.repeat(40),
    rtpengine_image_digest: `sha256:${'b'.repeat(64)}`,
    config_hash: `sha256:${'c'.repeat(64)}`,
    runtime_mode: 'userspace' as const
  };

  it('builds exact media-control commands with payload integrity', () => {
    const command = createRtpengineAcceptanceCommand({
      action: 'offer',
      command_id: 'task9-offer-1',
      call_id: 'task9-call-1',
      tenant_id: 'goal3-tenant',
      admission_reservation_id: 'cell-reservation-1',
      media_reservation_id: 'task9-reservation-1',
      cell_id: 'cell-a',
      owner_node_id: 'rustpbx-node-a',
      owner_epoch: '7',
      command_sequence: 1,
      expires_at: '2026-07-26T05:00:00.000Z',
      payload: {
        offer_sdp: 'v=0\r\n',
        media_profile_id: 'g711-relay-v1',
        from_tag: 'from-task9'
      }
    });

    assert.equal(command.protocol_version, 'ivekit.media-control.v1');
    assert.equal(command.owner_epoch, '7');
    assert.equal(command.tenant_id, 'goal3-tenant');
    assert.equal(command.admission_reservation_id, 'cell-reservation-1');
    assert.equal(command.cell_id, 'cell-a');
    assert.equal(command.owner_node_id, 'rustpbx-node-a');
    assert.equal(command.command_sequence, 1);
    assert.equal(command.payload_hash, mediaControlPayloadHash(command.payload));
    assert.equal(command.idempotency_key, 'task9-offer-1');
  });

  it('emits bounded evidence and keeps untested capabilities explicit', () => {
    const checks = Object.fromEntries(
      RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS.map((name) => [name, true])
    ) as Record<(typeof RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS)[number], boolean>;
    const evidence = buildRtpengineAcceptanceEvidence({
      identity,
      generated_at: '2026-07-26T04:00:00.000Z',
      checks,
      observations: {
        plaintext_packets: 40,
        srtp_packets: 40,
        control_outage_packets: 20,
        wal_inode_preserved: true
      },
      not_run: [
        { dependency: 'kernel-forwarding', reason: 'userspace runtime selected' },
        { dependency: 'recording', reason: 'independent Task 10 capability' },
        { dependency: 'transcoding', reason: 'independent Task 11 capability' }
      ]
    });

    assert.equal(evidence.status, 'passed');
    assert.equal(evidence.capacity_claim, 'none');
    assert.deepEqual(
      evidence.not_run.map((entry) => entry.dependency),
      ['kernel-forwarding', 'recording', 'transcoding']
    );
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 1_048_576);
  });

  it('rejects mutable or incomplete deployment identity', () => {
    assert.throws(
      () => buildRtpengineAcceptanceEvidence({
        identity: {
          ...identity,
          rtpengine_image_digest: 'rtpengine:latest'
        },
        generated_at: '2026-07-26T04:00:00.000Z',
        checks: Object.fromEntries(
          RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS.map((name) => [name, true])
        ) as Record<(typeof RTPENGINE_ACCEPTANCE_REQUIRED_CHECKS)[number], boolean>,
        observations: {},
        not_run: []
      }),
      /immutable RTPengine image digest/
    );
  });

  it('acceptance CLI confines lifecycle actions to its container prefix', () => {
    const env = {
      IVEKIT_MEDIA_CONTROL_ENDPOINT: 'http://127.0.0.1:33211',
      IVEKIT_MEDIA_CONTROL_TOKEN: 'task9-media-control-token-123456789',
      IVEKIT_RTPENGINE_ACCEPTANCE_BIND_ADDRESS: '127.0.0.1',
      IVEKIT_RTPENGINE_ACCEPTANCE_EXPIRES_AT: '2099-01-01T00:00:00.000Z',
      IVEKIT_RTPENGINE_ACCEPTANCE_SOURCE_COMMIT: 'a'.repeat(40),
      IVEKIT_RTPENGINE_ACCEPTANCE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
      IVEKIT_RTPENGINE_ACCEPTANCE_CONFIG_HASH: `sha256:${'c'.repeat(64)}`,
      IVEKIT_RTPENGINE_ACCEPTANCE_RUNTIME_MODE: 'userspace',
      IVEKIT_RTPENGINE_ACCEPTANCE_OUTPUT: '/evidence/task9.json',
      IVEKIT_RTPENGINE_ACCEPTANCE_SOURCE_DIR: '/work',
      IVEKIT_RTPENGINE_ACCEPTANCE_DOCKER_BINARY: '/usr/bin/docker',
      IVEKIT_RTPENGINE_ACCEPTANCE_CONTAINER_PREFIX: 'ivekit-goal2-task9-',
      IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_CONTROL_CONTAINER:
        'ivekit-goal2-task9-media-control',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CONTAINER:
        'ivekit-goal2-task9-admission',
      IVEKIT_RTPENGINE_ACCEPTANCE_RTPENGINE_CONTAINER:
        'ivekit-goal2-task9-rtpengine',
      IVEKIT_RTPENGINE_ACCEPTANCE_NG_HOST: '127.0.0.1',
      IVEKIT_RTPENGINE_ACCEPTANCE_NG_PORT: '32222',
      IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_PORT_MIN: '36000',
      IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_PORT_MAX: '36100',
      IVEKIT_RTPENGINE_ACCEPTANCE_MAX_ACTIVE_CALLS: '2'
    };

    const config = loadRtpengineAcceptanceCliConfig(env);
    assert.equal(
      config.containers.media_control,
      'ivekit-goal2-task9-media-control'
    );
    const authoritative = loadRtpengineAcceptanceCliConfig({
      ...env,
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ENDPOINT:
        'http://127.0.0.1:33200',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TOKEN:
        'task9-admission-token-123456789',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TENANT_ID: 'goal3-tenant',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REGION_ID: 'region-a',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ZONE_ID: 'zone-a',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CELL_ID: 'ivekit-cell-a',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_PROFILE_ID: 'voice-ordinary-v1',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_OWNER_NODE_ID:
        'rustpbx-node-a',
      IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REQUIRED_CAPACITY_JSON:
        '{"voice.weighted_calls":1}'
    });
    assert.ok(authoritative.admission);
    assert.throws(
      () => loadRtpengineAcceptanceCliConfig({
        ...env,
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ENDPOINT:
          'http://127.0.0.1:33200'
      }),
      /Cell admission configuration must be complete/
    );
    assert.throws(
      () => loadRtpengineAcceptanceCliConfig({
        ...env,
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CONTAINER: 'led-platform-api-1'
      }),
      /acceptance container prefix/
    );
  });

  it('acceptance takeover advances into the current Cell lease epoch', async () => {
    const previousOwnerEpoch = (142n * 4_294_967_296n + 2n).toString();
    const expectedOwnerEpoch = (143n * 4_294_967_296n + 1n).toString();
    let requestedOwnerEpoch = '';
    const server = createServer(async (request, response) => {
      if (request.method === 'GET' && request.url === '/v1/state') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          data: {
            state: 'accepting',
            cell_lease_epoch: 143,
            capacity_sequence: 1,
            nodes: [{
              node_id: 'rustpbx-node-a',
              state: 'accepting',
              recovery_safe_after: ''
            }],
            reservations: [{
              reservation_id: 'reservation-a',
              state: 'active',
              owner_node_id: 'rustpbx-node-a',
              owner_epoch: previousOwnerEpoch
            }]
          }
        }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requestedOwnerEpoch = String(body.owner_epoch || '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: {
          reservation_id: 'reservation-a',
          state: 'active',
          region_id: 'region-a',
          zone_id: 'zone-a',
          cell_id: 'ivekit-cell-a',
          owner_node_id: 'rustpbx-node-a',
          owner_epoch: requestedOwnerEpoch,
          endpoint: 'http://rustpbx:8080',
          expires_at: '2099-01-01T00:00:00.000Z',
          required_capacity: { 'voice.weighted_calls': 1 }
        }
      }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    try {
      const config = loadRtpengineAcceptanceCliConfig({
        IVEKIT_MEDIA_CONTROL_ENDPOINT: 'http://127.0.0.1:33211',
        IVEKIT_MEDIA_CONTROL_TOKEN: 'task9-media-control-token-123456789',
        IVEKIT_RTPENGINE_ACCEPTANCE_BIND_ADDRESS: '127.0.0.1',
        IVEKIT_RTPENGINE_ACCEPTANCE_EXPIRES_AT:
          '2099-01-01T00:00:00.000Z',
        IVEKIT_RTPENGINE_ACCEPTANCE_SOURCE_COMMIT: 'a'.repeat(40),
        IVEKIT_RTPENGINE_ACCEPTANCE_IMAGE_DIGEST:
          `sha256:${'b'.repeat(64)}`,
        IVEKIT_RTPENGINE_ACCEPTANCE_CONFIG_HASH:
          `sha256:${'c'.repeat(64)}`,
        IVEKIT_RTPENGINE_ACCEPTANCE_RUNTIME_MODE: 'userspace',
        IVEKIT_RTPENGINE_ACCEPTANCE_OUTPUT: '/evidence/task9.json',
        IVEKIT_RTPENGINE_ACCEPTANCE_SOURCE_DIR: '/work',
        IVEKIT_RTPENGINE_ACCEPTANCE_DOCKER_BINARY: '/usr/bin/docker',
        IVEKIT_RTPENGINE_ACCEPTANCE_CONTAINER_PREFIX:
          'ivekit-goal2-task9-',
        IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_CONTROL_CONTAINER:
          'ivekit-goal2-task9-media-control',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CONTAINER:
          'ivekit-goal2-task9-admission',
        IVEKIT_RTPENGINE_ACCEPTANCE_RTPENGINE_CONTAINER:
          'ivekit-goal2-task9-rtpengine',
        IVEKIT_RTPENGINE_ACCEPTANCE_NG_HOST: '127.0.0.1',
        IVEKIT_RTPENGINE_ACCEPTANCE_NG_PORT: '32222',
        IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_PORT_MIN: '36000',
        IVEKIT_RTPENGINE_ACCEPTANCE_MEDIA_PORT_MAX: '36100',
        IVEKIT_RTPENGINE_ACCEPTANCE_MAX_ACTIVE_CALLS: '2',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ENDPOINT:
          `http://127.0.0.1:${address.port}`,
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TOKEN:
          'task9-admission-token-123456789',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_TENANT_ID: 'goal3-tenant',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REGION_ID: 'region-a',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_ZONE_ID: 'zone-a',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_CELL_ID: 'ivekit-cell-a',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_PROFILE_ID:
          'voice-ordinary-v1',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_OWNER_NODE_ID:
          'rustpbx-node-a',
        IVEKIT_RTPENGINE_ACCEPTANCE_ADMISSION_REQUIRED_CAPACITY_JSON:
          '{"voice.weighted_calls":1}'
      });
      assert.ok(config.admission);
      const takenOver = await config.admission.takeover({
        admission_reservation_id: 'reservation-a',
        tenant_id: 'goal3-tenant',
        cell_id: 'ivekit-cell-a',
        owner_node_id: 'rustpbx-node-a',
        owner_epoch: previousOwnerEpoch
      });

      assert.equal(requestedOwnerEpoch, expectedOwnerEpoch);
      assert.equal(takenOver.owner_epoch, expectedOwnerEpoch);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('starts acceptance from a clean isolated RTPengine process', async () => {
    const calls: string[] = [];

    const activeCalls = await prepareIsolatedRtpengineEnvironment({
      restart: async () => {
        calls.push('restart');
      },
      undrain: async () => {
        calls.push('undrain');
      },
      active_calls: async () => {
        calls.push('active-calls');
        return 0;
      }
    });

    assert.equal(activeCalls, 0);
    assert.deepEqual(calls, ['restart', 'undrain', 'active-calls']);
  });

  it('rejects a dirty RTPengine process after isolated restart', async () => {
    await assert.rejects(
      prepareIsolatedRtpengineEnvironment({
        restart: async () => undefined,
        undrain: async () => undefined,
        active_calls: async () => 1
      }),
      /active calls after isolated restart: 1/
    );
  });

  it('runs offer, answer, real bidirectional UDP, RTCP, and delete', async () => {
    const token = 'task9-test-token-that-is-long-enough';
    let offerSdp = '';
    let answerSdp = '';
    const actions: string[] = [];
    const commands: Array<Record<string, any>> = [];
    const commandIds = new Set<string>();
    const authority = fakeAcceptanceAdmission();
    let fetchCalls = 0;
    const mediaControlFetch: typeof fetch = async (...arguments_) => {
      fetchCalls += 1;
      return globalThis.fetch(...arguments_);
    };
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      commands.push(command);
      actions.push(command.action);
      if (command.action === 'offer') offerSdp = command.payload.offer_sdp;
      if (command.action === 'answer') answerSdp = command.payload.answer_sdp;
      const replayed = commandIds.has(command.command_id);
      commandIds.add(command.command_id);
      const effectiveSdp = command.action === 'offer'
        ? offerSdp
        : command.action === 'answer'
          ? answerSdp
          : answerSdp || offerSdp;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: {
          protocol_version: 'ivekit.media-control.v1',
          result_class: replayed ? 'replayed' : 'committed',
          command_id: command.command_id,
          session: {
            media_reservation_id: command.media_reservation_id,
            call_id: command.call_id,
            owner_epoch: command.owner_epoch,
            last_sequence: command.command_sequence,
            state: command.action === 'delete' ? 'closed'
              : command.action === 'answer' ? 'committed' : 'prepared',
            transport_session_id: command.call_id,
            effective_sdp: effectiveSdp,
            expires_at: command.expires_at,
            updated_at: '2026-07-26T04:00:00.000Z'
          }
        }
      }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    try {
      const result = await runRtpengineMediaScenario({
        media_control_base_url: `http://127.0.0.1:${address.port}`,
        media_control_token: token,
        media_control_fetch: mediaControlFetch,
        bind_address: '127.0.0.1',
        mode: 'rtp',
        scenario_id: 'unit-plain',
        owner_epoch: '1',
        admission: authority.port,
        packet_count: 8,
        packet_interval_ms: 1,
        receive_timeout_ms: 1_000,
        during_stream: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      });
      const srtpResult = await runRtpengineMediaScenario({
        media_control_base_url: `http://127.0.0.1:${address.port}`,
        media_control_token: token,
        media_control_fetch: mediaControlFetch,
        bind_address: '127.0.0.1',
        mode: 'sdes_srtp',
        scenario_id: 'unit-srtp',
        owner_epoch: '2',
        admission: authority.port,
        packet_count: 8,
        packet_interval_ms: 1,
        receive_timeout_ms: 1_000
      });

      assert.deepEqual(actions, [
        'offer', 'answer', 'query', 'delete', 'delete',
        'offer', 'answer', 'delete'
      ]);
      assert.equal(fetchCalls, actions.length);
      assert.deepEqual(authority.events, [
        'reserve:task9-call-unit-plain',
        'activate:admission-task9-call-unit-plain',
        'takeover:admission-task9-call-unit-plain',
        'close:admission-task9-call-unit-plain',
        'reserve:task9-call-unit-srtp',
        'activate:admission-task9-call-unit-srtp',
        'close:admission-task9-call-unit-srtp'
      ]);
      const plaintextAnswer = commands.find((command) =>
        command.action === 'answer' &&
        command.call_id === 'task9-call-unit-plain'
      );
      const plaintextQuery = commands.find((command) =>
        command.action === 'query' &&
        command.call_id === 'task9-call-unit-plain'
      );
      assert.ok(plaintextAnswer);
      assert.ok(plaintextQuery);
      assert.ok(
        BigInt(plaintextQuery.owner_epoch) >
        BigInt(plaintextAnswer.owner_epoch)
      );
      assert.equal(plaintextQuery.command_sequence, 1);
      assert.ok(commands.every((command) =>
        command.admission_reservation_id.startsWith('admission-task9-call-') &&
        command.tenant_id === 'goal3-tenant' &&
        command.cell_id === 'ivekit-cell-a' &&
        command.owner_node_id === 'rustpbx-node-a' &&
        BigInt(command.owner_epoch) >= 4_294_967_297n
      ));
      assert.equal(result.endpoint_a.unique_packets, 8);
      assert.equal(result.endpoint_b.unique_packets, 8);
      assert.equal(result.endpoint_a.rtcp_packets, 1);
      assert.equal(result.endpoint_b.rtcp_packets, 1);
      assert.equal(result.deleted_result_class, 'committed');
      assert.equal(result.query_result_class, 'committed');
      assert.equal(result.delete_replay_result_class, 'replayed');
      assert.equal(result.continuity?.relay_port_preserved_after_restart, true);
      assert.ok(
        (result.continuity?.received_after_callback || 0) >
        (result.continuity?.received_before_callback || 0)
      );
      assert.equal(srtpResult.endpoint_a.unique_packets, 8);
      assert.equal(srtpResult.endpoint_b.unique_packets, 8);
      assert.equal(srtpResult.endpoint_a.wire_plaintext_match_packets, 0);
      assert.equal(srtpResult.endpoint_b.wire_plaintext_match_packets, 0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it('deletes committed media before closing admission after a later failure', async () => {
    const authority = fakeAcceptanceAdmission();
    const actions: string[] = [];
    let offerSdp = '';
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      actions.push(command.action);
      if (command.action === 'offer') {
        offerSdp = command.payload.offer_sdp;
      }
      const result = command.action === 'answer'
        ? failure(
            command.command_id,
            'terminal_error',
            'rtpengine_answer_rejected',
            false
          )
        : success(command, offerSdp);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: result }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    try {
      await assert.rejects(
        runRtpengineMediaScenario({
          media_control_base_url: `http://127.0.0.1:${address.port}`,
          media_control_token: 'task9-cleanup-token-that-is-long-enough',
          bind_address: '127.0.0.1',
          mode: 'rtp',
          scenario_id: 'unit-cleanup',
          owner_epoch: '1',
          packet_count: 8,
          packet_interval_ms: 1,
          receive_timeout_ms: 1_000,
          admission: authority.port
        }),
        /RTPengine answer failed/
      );
      assert.deepEqual(actions, ['offer', 'answer', 'delete']);
      assert.deepEqual(authority.events, [
        'reserve:task9-call-unit-cleanup',
        'activate:admission-task9-call-unit-cleanup',
        'close:admission-task9-call-unit-cleanup'
      ]);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });

  it('preserves a stream failure while bounded sends settle before socket close', async () => {
    const authority = fakeAcceptanceAdmission();
    let offerSdp = '';
    let answerSdp = '';
    const actions: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      actions.push(command.action);
      if (command.action === 'offer') offerSdp = command.payload.offer_sdp;
      if (command.action === 'answer') answerSdp = command.payload.answer_sdp;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        data: success(command, answerSdp || offerSdp)
      }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    try {
      await assert.rejects(
        runRtpengineMediaScenario({
          media_control_base_url: `http://127.0.0.1:${address.port}`,
          media_control_token: 'task9-stream-token-that-is-long-enough',
          bind_address: '127.0.0.1',
          mode: 'rtp',
          scenario_id: 'unit-stream-failure',
          owner_epoch: '1',
          packet_count: 50,
          packet_interval_ms: 5,
          receive_timeout_ms: 1_000,
          admission: authority.port,
          during_stream: async () => {
            throw new Error('control-plane-recovery-failed');
          }
        }),
        /control-plane-recovery-failed/
      );
      assert.deepEqual(actions, ['offer', 'answer', 'delete']);
      assert.deepEqual(authority.events, [
        'reserve:task9-call-unit-stream-failure',
        'activate:admission-task9-call-unit-stream-failure',
        'close:admission-task9-call-unit-stream-failure'
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('runs drain, capacity, epoch, and RTPengine outage controls', async () => {
    const token = 'task9-control-token-that-is-long-enough';
    let draining = false;
    let engineRunning = true;
    let fetchCalls = 0;
    const authority = fakeAcceptanceAdmission();
    const active = new Map<string, { epoch: bigint; sdp: string }>();
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const current = active.get(command.media_reservation_id);
      let result: Record<string, unknown>;
      if (!engineRunning) {
        result = failure(
          command.command_id,
          'terminal_error',
          'rtpengine_ng_connect_failed',
          true
        );
      } else if (command.action === 'offer' && draining) {
        result = failure(
          command.command_id,
          'terminal_error',
          'rtpengine_node_draining',
          true
        );
      } else if (command.action === 'offer' && active.size >= 2) {
        result = failure(
          command.command_id,
          'rejected_capacity',
          'rtpengine_capacity_exhausted',
          true
        );
      } else if (current && BigInt(command.owner_epoch) < current.epoch) {
        result = failure(
          command.command_id,
          'rejected_epoch',
          'stale_owner_epoch',
          false
        );
      } else {
        const sdp = command.payload.offer_sdp || current?.sdp || [
          'v=0',
          'o=- 1 1 IN IP4 127.0.0.1',
          's=task9',
          'c=IN IP4 127.0.0.1',
          't=0 0',
          'm=audio 24000 RTP/AVP 0',
          ''
        ].join('\r\n');
        if (command.action === 'delete') {
          active.delete(command.media_reservation_id);
        } else {
          active.set(command.media_reservation_id, {
            epoch: BigInt(command.owner_epoch),
            sdp
          });
        }
        result = success(command, sdp);
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: result }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    assert.ok(address && typeof address !== 'string');

    try {
      const matrix = await runRtpengineControlMatrix({
        media_control_base_url: `http://127.0.0.1:${address.port}`,
        media_control_token: token,
        media_control_fetch: async (...arguments_) => {
          fetchCalls += 1;
          return globalThis.fetch(...arguments_);
        },
        bind_address: '127.0.0.1',
        expires_at: '2099-01-01T00:00:00.000Z',
        maximum_active_calls: 2,
        admission: authority.port,
        set_drain: async (value) => {
          draining = value;
        },
        stop_rtpengine: async () => {
          engineRunning = false;
        },
        start_rtpengine: async () => {
          engineRunning = true;
        },
        regression_checks: {
          before_write_failure_classified: true,
          after_write_disconnect_reconciled: true
        }
      });

      assert.equal(matrix.checks.drain_rejects_new, true);
      assert.equal(matrix.checks.hard_capacity_rejects_new, true);
      assert.equal(matrix.checks.stale_epoch_rejected, true);
      assert.equal(matrix.checks.higher_epoch_takeover, true);
      assert.equal(matrix.checks.rtpengine_failure_classified, true);
      assert.ok(fetchCalls > 0);
      assert.equal(active.size, 0);
      assert.equal(
        authority.events.filter((event) => event.startsWith('takeover:')).length,
        1
      );
      assert.equal(
        authority.states.size,
        authority.events.filter((event) => event.startsWith('close:')).length
      );
      assert.ok([...authority.states.values()].every((state) => state === 'closed'));
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
    }
  });
});

function failure(
  commandId: string,
  resultClass: 'unknown' | 'terminal_error' | 'rejected_capacity' | 'rejected_epoch',
  errorCode: string,
  retryable: boolean
): Record<string, unknown> {
  return {
    protocol_version: 'ivekit.media-control.v1',
    result_class: resultClass,
    command_id: commandId,
    error_code: errorCode,
    retryable
  };
}

function success(
  command: Record<string, any>,
  effectiveSdp: string
): Record<string, unknown> {
  return {
    protocol_version: 'ivekit.media-control.v1',
    result_class: 'committed',
    command_id: command.command_id,
    session: {
      media_reservation_id: command.media_reservation_id,
      call_id: command.call_id,
      owner_epoch: command.owner_epoch,
      last_sequence: command.command_sequence,
      state: command.action === 'delete' ? 'closed' : 'prepared',
      transport_session_id: command.call_id,
      effective_sdp: effectiveSdp,
      expires_at: command.expires_at,
      updated_at: '2026-07-26T04:00:00.000Z'
    }
  };
}

function fakeAcceptanceAdmission(): {
  port: RtpengineAcceptanceAdmissionPort;
  events: string[];
  states: Map<string, 'reserved' | 'active' | 'closed'>;
} {
  const events: string[] = [];
  const states = new Map<string, 'reserved' | 'active' | 'closed'>();
  const identities = new Map<string, RtpengineAcceptanceAdmissionIdentity>();
  let sequence = 0n;
  const required = (reservation: RtpengineAcceptanceAdmissionIdentity) => {
    const current = identities.get(reservation.admission_reservation_id);
    assert.ok(current);
    return current;
  };
  const port: RtpengineAcceptanceAdmissionPort = {
    reserve: async ({ interaction_id }) => {
      sequence += 1n;
      const identity = {
        admission_reservation_id: `admission-${interaction_id}`,
        tenant_id: 'goal3-tenant',
        cell_id: 'ivekit-cell-a',
        owner_node_id: 'rustpbx-node-a',
        owner_epoch: (4_294_967_296n + sequence).toString()
      };
      identities.set(identity.admission_reservation_id, identity);
      states.set(identity.admission_reservation_id, 'reserved');
      events.push(`reserve:${interaction_id}`);
      return identity;
    },
    activate: async (reservation) => {
      const current = required(reservation);
      states.set(current.admission_reservation_id, 'active');
      events.push(`activate:${current.admission_reservation_id}`);
      return current;
    },
    takeover: async (reservation) => {
      const current = required(reservation);
      const next = {
        ...current,
        owner_epoch: (BigInt(current.owner_epoch) + 1n).toString()
      };
      identities.set(next.admission_reservation_id, next);
      events.push(`takeover:${next.admission_reservation_id}`);
      return next;
    },
    close: async (reservation) => {
      const current = required(reservation);
      states.set(current.admission_reservation_id, 'closed');
      events.push(`close:${current.admission_reservation_id}`);
    }
  };
  return { port, events, states };
}
