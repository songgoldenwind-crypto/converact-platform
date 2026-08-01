import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runSippRtpCheckCampaign,
  sippRtpCheckCampaignOptionsFromEnv,
  type SippRtpCheckCampaignCommandResult
} from '../scripts/capacity/sipp-rtp-campaign.js';

function rtpDebug(packetCount: number): string {
  const lines: string[] = [];
  for (let sequence = 1; sequence <= packetCount; sequence += 1) {
    const sequenceHex = sequence.toString(16).padStart(4, '0');
    const timestampHex = (sequence * 160).toString(16).padStart(8, '0');
    const packet = `8000${sequenceHex}${timestampHex}0102030400`;
    lines.push(
      `TID: 101 SIPP SUCCESS SEND LOG: 13 0x1 0 [${packet}]`,
      `TID: 101 SIPP SUCCESS RECV LOG: 13 0x1 0 [${packet}]`,
      'TID: 101 COMPARISON OK 0 0x1 0 []'
    );
  }
  lines.push(
    'TID: 101 ----RTPCHECKS----',
    '0',
    'TID: 101 ----PACKET COUNTS----',
    String(packetCount),
    ''
  );
  return lines.join('\n');
}

test('SIPp RTP campaign emits a strict controlled-pass evidence bundle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-rtp-campaign-'));
  const binary = join(directory, 'sipp');
  writeFileSync(binary, 'pinned-sipp');
  const commands: string[][] = [];
  const result = (overrides: Partial<SippRtpCheckCampaignCommandResult> = {}) => ({
    code: 0,
    stdout: '',
    stderr: '',
    timed_out: false,
    ...overrides
  });

  try {
    const report = await runSippRtpCheckCampaign({
      docker: 'docker',
      network: 'converact-rtp',
      target_ip: '172.30.44.9',
      uac_ip: '172.30.44.20',
      uas_ip: '172.30.44.22',
      sipp_binary: binary,
      sipp_sha256: createHash('sha256').update('pinned-sipp').digest('hex'),
      result_dir: directory,
      container_image: 'alpine@sha256:abc',
      run_id: 'pcmu-one',
      service: '18005550200',
      calls: 1,
      calls_per_second: 1,
      media_duration_ms: 5_000,
      timeout_seconds: 30,
      packets_per_second: 50,
      maximum_invalid_or_missing_ratio: 0.001,
      maximum_startup_missing_packets_per_call: 3,
      minimum_packet_coverage_ratio: 0.95,
      rtp_port_min: 6_000,
      rtp_tasks_per_thread: 64
    }, {
      command: async (_executable, args) => {
        commands.push(args);
        if (args[0] === 'inspect' && args.includes('--format={{.State.Running}}')) {
          return result({ stdout: 'true\n' });
        }
        if (args[0] === 'run' && args.includes('172.30.44.9:5060')) {
          writeFileSync(
            join(directory, 'rtp-check-uac.csv'),
            'SuccessfulCall(C);FailedCall(C);Retransmissions(C)\n1;0;0\n'
          );
          writeFileSync(
            join(directory, 'uac', 'debugafile'),
            rtpDebug(250)
          );
        }
        if (args[0] === 'wait') {
          writeFileSync(
            join(directory, 'rtp-check-uas.csv'),
            'SuccessfulCall(C);FailedCall(C);Retransmissions(C)\n1;0;0\n'
          );
          writeFileSync(
            join(directory, 'uas', 'debugafile'),
            rtpDebug(250)
          );
          return result({ stdout: '0\n' });
        }
        return result({ stdout: args[0] === 'run' ? 'container-id\n' : '' });
      },
      now: () => new Date('2026-07-24T03:00:00.000Z'),
      sleep: async () => undefined
    });

    assert.equal(report.status, 'passed', report.error_code);
    assert.equal(report.media?.status, 'controlled_pass');
    assert.equal(report.media?.protocol, 'sipp_rtp_check');
    if (report.media?.protocol !== 'sipp_rtp_check') {
      assert.fail('strict RTP evidence is missing');
    }
    assert.equal(report.media.packet_coverage_ratio, 1);
    assert.equal(report.sip.uac?.successful_calls, 1);
    assert.equal(report.sip.uas?.successful_calls, 1);
    assert.match(
      readFileSync(join(directory, 'rtp-check-uac.xml'), 'utf8'),
      /pause milliseconds="5000"/
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8')),
      report
    );
    assert.ok(commands.find((args) => args[0] === 'network'));
    assert.ok(commands.find((args) => args[0] === 'image'));
    assert.ok(commands.find((args) => args[0] === 'rm' && args.includes(
      'converact-rtp-uac-pcmu-one'
    )));
    assert.ok(commands.find((args) => args[0] === 'rm' && args.includes(
      'converact-rtp-uas-pcmu-one'
    )));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIPp RTP campaign classifies incomplete media generation separately', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'converact-rtp-generator-'));
  const binary = join(directory, 'sipp');
  writeFileSync(binary, 'pinned-sipp');
  const commandResult = {
    code: 0,
    stdout: '',
    stderr: '',
    timed_out: false
  };

  try {
    const report = await runSippRtpCheckCampaign({
      docker: 'docker',
      network: 'converact-rtp',
      target_ip: '172.30.44.9',
      uac_ip: '172.30.44.20',
      uas_ip: '172.30.44.22',
      sipp_binary: binary,
      sipp_sha256: createHash('sha256').update('pinned-sipp').digest('hex'),
      result_dir: directory,
      container_image: 'alpine@sha256:abc',
      run_id: 'pcmu-two',
      service: '18005550200',
      calls: 2,
      calls_per_second: 2,
      media_duration_ms: 5_000,
      timeout_seconds: 30,
      packets_per_second: 50,
      maximum_invalid_or_missing_ratio: 0.001,
      maximum_startup_missing_packets_per_call: 3,
      minimum_packet_coverage_ratio: 0.95,
      rtp_port_min: 6_000,
      rtp_tasks_per_thread: 64
    }, {
      command: async (_executable, args) => {
        if (args[0] === 'inspect' && args.includes('--format={{.State.Running}}')) {
          return { ...commandResult, stdout: 'true\n' };
        }
        if (args[0] === 'run' && args.includes('172.30.44.9:5060')) {
          writeFileSync(
            join(directory, 'rtp-check-uac.csv'),
            'SuccessfulCall(C);FailedCall(C);Retransmissions(C)\n2;0;0\n'
          );
          writeFileSync(
            join(directory, 'uac', 'debugafile'),
            rtpDebug(250)
          );
        }
        if (args[0] === 'wait') {
          writeFileSync(
            join(directory, 'rtp-check-uas.csv'),
            'SuccessfulCall(C);FailedCall(C);Retransmissions(C)\n2;0;0\n'
          );
          writeFileSync(
            join(directory, 'uas', 'debugafile'),
            rtpDebug(250)
          );
          return { ...commandResult, stdout: '0\n' };
        }
        return commandResult;
      },
      now: () => new Date('2026-07-24T03:00:00.000Z'),
      sleep: async () => undefined
    });

    assert.equal(report.status, 'failed');
    assert.equal(report.media?.status, 'invalid_generator_capacity');
    assert.equal(report.media?.failure_class, 'generator');
    assert.equal(report.error_code, 'invalid_generator_capacity');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SIPp RTP campaign environment parser rejects fractional media windows', () => {
  assert.throws(
    () => sippRtpCheckCampaignOptionsFromEnv({
      CONVERACT_FABRIC_SIPP_BINARY: '/cache/sipp',
      CONVERACT_FABRIC_RTP_CHECK_NETWORK: 'converact-rtp',
      CONVERACT_FABRIC_RTP_CHECK_MEDIA_DURATION_MS: '1500'
    }),
    /whole seconds/
  );
});
