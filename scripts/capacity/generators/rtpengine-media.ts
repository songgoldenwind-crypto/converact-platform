import {
  createCipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import {
  createSocket,
  type RemoteInfo,
  type Socket
} from 'node:dgram';
import { isIP } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const RTP_FIXED_HEADER_BYTES = 12;
const SRTP_AUTH_TAG_BYTES = 10;
const RTP_SEQUENCE_MODULUS = 0x1_0000;
const RTP_TIMESTAMP_MODULUS = 0x1_0000_0000;

export interface PcmuRtpPacketInput {
  sequence: number;
  timestamp: number;
  ssrc: number;
  payload: Buffer;
  marker?: boolean;
}

export interface ParsedRtpPacket {
  version: number;
  marker: boolean;
  payload_type: number;
  sequence: number;
  timestamp: number;
  ssrc: number;
  header_bytes: number;
  payload: Buffer;
}

export interface RtpStreamEvidence {
  received_packets: number;
  unique_packets: number;
  lost_packets: number;
  duplicate_packets: number;
  out_of_order_packets: number;
  first_packet_ms: number | null;
  jitter_ms: number;
}

export interface RtpMediaEndpointEvidence extends RtpStreamEvidence {
  rtcp_packets: number;
  invalid_packets: number;
  sent_rtp_packets: number;
  sent_rtcp_packets: number;
  sent_octets: number;
  wire_plaintext_match_packets: number;
}

export interface RelayEndpoint {
  address: string;
  port: number;
  profile: string;
  payload_types: number[];
}

export interface RtcpSenderReportInput {
  ssrc: number;
  ntp_seconds: number;
  ntp_fraction: number;
  rtp_timestamp: number;
  packet_count: number;
  octet_count: number;
}

export interface ParsedRtcpPacket {
  version: number;
  packet_type: number;
  report_count: number;
  ssrc: number;
  packet_count?: number;
  octet_count?: number;
}

export interface SdesSrtpContext {
  readonly suite: 'AES_CM_128_HMAC_SHA1_80';
  readonly ssrc: number;
  readonly encryption_key: Buffer;
  readonly authentication_key: Buffer;
  readonly session_salt: Buffer;
  send_rollover_counter: number;
  send_last_sequence: number | null;
  receive_rollover_counter: number;
  receive_last_sequence: number | null;
  receive_highest_index: number;
}

export interface SdesKeyMaterial {
  suite: 'AES_CM_128_HMAC_SHA1_80';
  master_key: Buffer;
  master_salt: Buffer;
  inline_key: string;
}

export class RtpMediaEndpoint {
  readonly #socket: Socket;
  readonly #collector: RtpStreamCollector;
  readonly #ssrc: number;
  readonly #expectedRemoteSsrc: number;
  readonly #maximumPackets: number;
  readonly #startedAtMs: number;
  #nextSequence = 1;
  #nextTimestamp = 0;
  #sentRtpPackets = 0;
  #sentRtcpPackets = 0;
  #sentOctets = 0;
  #receivedRtcpPackets = 0;
  #invalidPackets = 0;
  #wirePlaintextMatchPackets = 0;
  #sendSrtp: SdesSrtpContext | null = null;
  #receiveSrtp: SdesSrtpContext | null = null;
  #error: Error | null = null;
  #closed = false;

  constructor(input: {
    socket: Socket;
    ssrc: number;
    expected_remote_ssrc: number;
    maximum_packets: number;
  }) {
    this.#socket = input.socket;
    this.#ssrc = input.ssrc;
    this.#expectedRemoteSsrc = input.expected_remote_ssrc;
    this.#maximumPackets = input.maximum_packets;
    this.#startedAtMs = Date.now();
    this.#collector = new RtpStreamCollector({
      clock_rate_hz: 8_000,
      expected_payload_type: 0,
      expected_ssrc: input.expected_remote_ssrc,
      maximum_tracked_packets: input.maximum_packets
    });
    this.#socket.on('message', (packet) => this.#observe(packet));
    this.#socket.on('error', (error) => {
      this.#error ??= error;
    });
  }

  localEndpoint(): { address: string; port: number } {
    this.#assertOpen();
    const address = this.#socket.address();
    if (typeof address === 'string') {
      throw new Error('RTP endpoint is not an IP socket');
    }
    return { address: address.address, port: address.port };
  }

  configureSrtp(input: {
    send_key_material: SdesKeyMaterial;
    receive_key_material: SdesKeyMaterial;
  }): void {
    this.#assertOpen();
    const received = this.#collector.snapshot({
      expected_packets: 0,
      started_at_ms: this.#startedAtMs
    }).received_packets;
    if (this.#sendSrtp ||
        this.#receiveSrtp ||
        this.#sentRtpPackets > 0 ||
        received > 0) {
      throw new Error('SRTP must be configured before media starts');
    }
    const send = checkedSdesKeyMaterial(input.send_key_material);
    const receive = checkedSdesKeyMaterial(input.receive_key_material);
    this.#sendSrtp = createSdesSrtpContext({
      suite: send.suite,
      master_key: send.master_key,
      master_salt: send.master_salt,
      ssrc: this.#ssrc
    });
    this.#receiveSrtp = createSdesSrtpContext({
      suite: receive.suite,
      master_key: receive.master_key,
      master_salt: receive.master_salt,
      ssrc: this.#expectedRemoteSsrc
    });
  }

  async sendPcmu(input: {
    target: { address: string; port: number };
    packet_count: number;
    packet_interval_ms?: number;
    payload_seed?: number;
  }): Promise<{ rtp_packets: number; octets: number }> {
    this.#assertOpen();
    const packetCount = boundedInteger(
      input.packet_count,
      1,
      this.#maximumPackets,
      'RTP send packet count'
    );
    if (this.#sentRtpPackets + packetCount > this.#maximumPackets) {
      throw new Error('RTP send packet limit exceeded');
    }
    const packetIntervalMs = boundedInteger(
      input.packet_interval_ms ?? 20,
      0,
      60_000,
      'RTP packet interval'
    );
    const payloadSeed = boundedInteger(
      input.payload_seed ?? 0x7f,
      0,
      0xff,
      'RTP payload seed'
    );
    const target = checkedEndpoint(input.target);
    let octets = 0;
    for (let index = 0; index < packetCount; index += 1) {
      this.#throwSocketError();
      const payload = Buffer.alloc(
        160,
        (payloadSeed + this.#nextSequence) & 0xff
      );
      const plaintextPacket = buildPcmuRtpPacket({
        sequence: this.#nextSequence,
        timestamp: this.#nextTimestamp,
        ssrc: this.#ssrc,
        payload
      });
      const packet = this.#sendSrtp
        ? protectSrtpPacket(this.#sendSrtp, plaintextPacket)
        : plaintextPacket;
      if (packet.includes(payload)) this.#wirePlaintextMatchPackets += 1;
      await sendDatagram(this.#socket, packet, target);
      this.#sentRtpPackets += 1;
      this.#sentOctets += payload.length;
      octets += payload.length;
      this.#nextSequence = (this.#nextSequence + 1) & 0xffff;
      this.#nextTimestamp = (this.#nextTimestamp + 160) >>> 0;
      if (packetIntervalMs > 0 && index + 1 < packetCount) {
        await delay(packetIntervalMs);
      }
    }
    return { rtp_packets: packetCount, octets };
  }

  async sendRtcp(targetInput: {
    address: string;
    port: number;
  }): Promise<void> {
    this.#assertOpen();
    const target = checkedEndpoint(targetInput);
    const unixMs = Date.now();
    const ntpSeconds = Math.floor(unixMs / 1_000) + 2_208_988_800;
    const ntpFraction = Math.floor(
      (unixMs % 1_000) / 1_000 * 0x1_0000_0000
    );
    const report = buildRtcpSenderReport({
      ssrc: this.#ssrc,
      ntp_seconds: ntpSeconds,
      ntp_fraction: ntpFraction,
      rtp_timestamp: this.#nextTimestamp,
      packet_count: this.#sentRtpPackets,
      octet_count: this.#sentOctets
    });
    await sendDatagram(this.#socket, report, target);
    this.#sentRtcpPackets += 1;
  }

  async waitFor(input: {
    rtp_packets: number;
    rtcp_packets: number;
    timeout_ms: number;
  }): Promise<void> {
    const rtpPackets = boundedInteger(
      input.rtp_packets,
      0,
      this.#maximumPackets,
      'RTP receive packet count'
    );
    const rtcpPackets = boundedInteger(
      input.rtcp_packets,
      0,
      this.#maximumPackets,
      'RTCP receive packet count'
    );
    const timeoutMs = boundedInteger(
      input.timeout_ms,
      1,
      300_000,
      'RTP receive timeout'
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      this.#throwSocketError();
      const snapshot = this.snapshot({ expected_packets: rtpPackets });
      if (snapshot.received_packets >= rtpPackets &&
          snapshot.rtcp_packets >= rtcpPackets) {
        return;
      }
      await delay(Math.min(5, Math.max(1, deadline - Date.now())));
    }
    const snapshot = this.snapshot({ expected_packets: rtpPackets });
    throw new Error(
      `RTP receive timeout: rtp=${snapshot.received_packets}/${rtpPackets} ` +
      `rtcp=${snapshot.rtcp_packets}/${rtcpPackets}`
    );
  }

  snapshot(input: { expected_packets: number }): RtpMediaEndpointEvidence {
    return {
      ...this.#collector.snapshot({
        expected_packets: input.expected_packets,
        started_at_ms: this.#startedAtMs
      }),
      rtcp_packets: this.#receivedRtcpPackets,
      invalid_packets: this.#invalidPackets,
      sent_rtp_packets: this.#sentRtpPackets,
      sent_rtcp_packets: this.#sentRtcpPackets,
      sent_octets: this.#sentOctets,
      wire_plaintext_match_packets: this.#wirePlaintextMatchPackets
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await new Promise<void>((resolve) => {
      this.#socket.close(() => resolve());
    });
  }

  #observe(packet: Buffer): void {
    try {
      if (isRtcp(packet)) {
        const report = parseRtcpPacket(packet);
        if (report.ssrc !== this.#expectedRemoteSsrc) {
          throw new Error('RTCP SSRC does not match');
        }
        this.#receivedRtcpPackets += 1;
        return;
      }
      const mediaPacket = this.#receiveSrtp
        ? unprotectSrtpPacket(this.#receiveSrtp, packet)
        : packet;
      this.#collector.observe(mediaPacket, Date.now());
    } catch {
      this.#invalidPackets += 1;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('RTP endpoint is closed');
    this.#throwSocketError();
  }

  #throwSocketError(): void {
    if (this.#error) throw this.#error;
  }
}

export async function openRtpMediaEndpoint(input: {
  bind_address: string;
  ssrc: number;
  expected_remote_ssrc: number;
  maximum_packets: number;
}): Promise<RtpMediaEndpoint> {
  const family = isIP(input.bind_address);
  if (family === 0) throw new Error('RTP bind address is invalid');
  const ssrc = uint(input.ssrc, 0xffff_ffff, 'RTP SSRC');
  const expectedRemoteSsrc = uint(
    input.expected_remote_ssrc,
    0xffff_ffff,
    'remote RTP SSRC'
  );
  const maximumPackets = boundedInteger(
    input.maximum_packets,
    1,
    10_000_000,
    'RTP endpoint packet limit'
  );
  const socket = createSocket(family === 4 ? 'udp4' : 'udp6');
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      socket.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      socket.off('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind({ address: input.bind_address, port: 0, exclusive: true });
  });
  return new RtpMediaEndpoint({
    socket,
    ssrc,
    expected_remote_ssrc: expectedRemoteSsrc,
    maximum_packets: maximumPackets
  });
}

export function buildPcmuRtpPacket(input: PcmuRtpPacketInput): Buffer {
  uint(input.sequence, 0xffff, 'RTP sequence');
  uint(input.timestamp, 0xffff_ffff, 'RTP timestamp');
  uint(input.ssrc, 0xffff_ffff, 'RTP SSRC');
  if (!Buffer.isBuffer(input.payload) ||
      input.payload.length < 1 ||
      input.payload.length > 65_507 - RTP_FIXED_HEADER_BYTES) {
    throw new Error('RTP payload is invalid');
  }
  const packet = Buffer.allocUnsafe(RTP_FIXED_HEADER_BYTES + input.payload.length);
  packet[0] = 0x80;
  packet[1] = (input.marker ? 0x80 : 0) | 0;
  packet.writeUInt16BE(input.sequence, 2);
  packet.writeUInt32BE(input.timestamp, 4);
  packet.writeUInt32BE(input.ssrc, 8);
  input.payload.copy(packet, RTP_FIXED_HEADER_BYTES);
  return packet;
}

export function parseRtpPacket(packet: Buffer): ParsedRtpPacket {
  if (!Buffer.isBuffer(packet) || packet.length < RTP_FIXED_HEADER_BYTES) {
    throw new Error('RTP packet is truncated');
  }
  const version = packet[0]! >>> 6;
  if (version !== 2) throw new Error('RTP version is unsupported');
  const padding = (packet[0]! & 0x20) !== 0;
  const extension = (packet[0]! & 0x10) !== 0;
  const csrcCount = packet[0]! & 0x0f;
  let headerBytes = RTP_FIXED_HEADER_BYTES + csrcCount * 4;
  if (headerBytes > packet.length) throw new Error('RTP CSRC list is truncated');
  if (extension) {
    if (headerBytes + 4 > packet.length) {
      throw new Error('RTP extension header is truncated');
    }
    const extensionWords = packet.readUInt16BE(headerBytes + 2);
    headerBytes += 4 + extensionWords * 4;
    if (headerBytes > packet.length) {
      throw new Error('RTP extension payload is truncated');
    }
  }
  const paddingBytes = padding ? packet[packet.length - 1]! : 0;
  if (padding && (paddingBytes < 1 || headerBytes + paddingBytes > packet.length)) {
    throw new Error('RTP padding is invalid');
  }
  const payloadEnd = packet.length - paddingBytes;
  return {
    version,
    marker: (packet[1]! & 0x80) !== 0,
    payload_type: packet[1]! & 0x7f,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    header_bytes: headerBytes,
    payload: Buffer.from(packet.subarray(headerBytes, payloadEnd))
  };
}

export class RtpStreamCollector {
  readonly #clockRateHz: number;
  readonly #expectedPayloadType: number;
  readonly #expectedSsrc: number;
  readonly #maximumTrackedPackets: number;
  readonly #seen = new Set<number>();
  #receivedPackets = 0;
  #duplicatePackets = 0;
  #outOfOrderPackets = 0;
  #firstArrivalMs: number | null = null;
  #maximumExtendedSequence: number | null = null;
  #lastRawTimestamp: number | null = null;
  #timestampCycles = 0;
  #previousTransit: number | null = null;
  #jitter = 0;

  constructor(input: {
    clock_rate_hz: number;
    expected_payload_type: number;
    expected_ssrc: number;
    maximum_tracked_packets?: number;
  }) {
    this.#clockRateHz = boundedInteger(
      input.clock_rate_hz,
      1,
      192_000,
      'RTP clock rate'
    );
    this.#expectedPayloadType = boundedInteger(
      input.expected_payload_type,
      0,
      127,
      'RTP payload type'
    );
    this.#expectedSsrc = uint(input.expected_ssrc, 0xffff_ffff, 'RTP SSRC');
    this.#maximumTrackedPackets = boundedInteger(
      input.maximum_tracked_packets ?? 1_000_000,
      1,
      10_000_000,
      'RTP tracked packet limit'
    );
  }

  observe(packet: Buffer, arrivedAtMs: number): void {
    if (!Number.isFinite(arrivedAtMs) || arrivedAtMs < 0) {
      throw new Error('RTP arrival time is invalid');
    }
    const parsed = parseRtpPacket(packet);
    if (parsed.payload_type !== this.#expectedPayloadType) {
      throw new Error('RTP payload type does not match');
    }
    if (parsed.ssrc !== this.#expectedSsrc) {
      throw new Error('RTP SSRC does not match');
    }
    this.#receivedPackets += 1;
    if (this.#firstArrivalMs === null) this.#firstArrivalMs = arrivedAtMs;

    const extendedSequence = this.#extendSequence(parsed.sequence);
    if (this.#seen.has(extendedSequence)) {
      this.#duplicatePackets += 1;
    } else {
      if (this.#seen.size >= this.#maximumTrackedPackets) {
        throw new Error('RTP tracked packet limit exceeded');
      }
      if (this.#maximumExtendedSequence !== null &&
          extendedSequence < this.#maximumExtendedSequence) {
        this.#outOfOrderPackets += 1;
      }
      this.#seen.add(extendedSequence);
      this.#maximumExtendedSequence = Math.max(
        this.#maximumExtendedSequence ?? extendedSequence,
        extendedSequence
      );
    }

    const extendedTimestamp = this.#extendTimestamp(parsed.timestamp);
    const transit = arrivedAtMs * this.#clockRateHz / 1_000 - extendedTimestamp;
    if (this.#previousTransit !== null) {
      const difference = Math.abs(transit - this.#previousTransit);
      this.#jitter += (difference - this.#jitter) / 16;
    }
    this.#previousTransit = transit;
  }

  snapshot(input: {
    expected_packets: number;
    started_at_ms: number;
  }): RtpStreamEvidence {
    const expectedPackets = boundedInteger(
      input.expected_packets,
      0,
      100_000_000,
      'expected RTP packets'
    );
    if (!Number.isFinite(input.started_at_ms) || input.started_at_ms < 0) {
      throw new Error('RTP start time is invalid');
    }
    return {
      received_packets: this.#receivedPackets,
      unique_packets: this.#seen.size,
      lost_packets: Math.max(0, expectedPackets - this.#seen.size),
      duplicate_packets: this.#duplicatePackets,
      out_of_order_packets: this.#outOfOrderPackets,
      first_packet_ms: this.#firstArrivalMs === null
        ? null
        : Math.max(0, this.#firstArrivalMs - input.started_at_ms),
      jitter_ms: this.#jitter * 1_000 / this.#clockRateHz
    };
  }

  #extendSequence(sequence: number): number {
    if (this.#maximumExtendedSequence === null) return sequence;
    const cycle = Math.floor(
      this.#maximumExtendedSequence / RTP_SEQUENCE_MODULUS
    );
    let candidate = cycle * RTP_SEQUENCE_MODULUS + sequence;
    if (candidate < this.#maximumExtendedSequence - 0x8000) {
      candidate += RTP_SEQUENCE_MODULUS;
    } else if (candidate > this.#maximumExtendedSequence + 0x8000) {
      candidate -= RTP_SEQUENCE_MODULUS;
    }
    return candidate;
  }

  #extendTimestamp(timestamp: number): number {
    if (this.#lastRawTimestamp !== null) {
      if (this.#lastRawTimestamp > 0xc000_0000 && timestamp < 0x4000_0000) {
        this.#timestampCycles += RTP_TIMESTAMP_MODULUS;
      } else if (
        this.#lastRawTimestamp < 0x4000_0000 &&
        timestamp > 0xc000_0000 &&
        this.#timestampCycles >= RTP_TIMESTAMP_MODULUS
      ) {
        return this.#timestampCycles - RTP_TIMESTAMP_MODULUS + timestamp;
      }
    }
    this.#lastRawTimestamp = timestamp;
    return this.#timestampCycles + timestamp;
  }
}

export function buildRtcpSenderReport(input: RtcpSenderReportInput): Buffer {
  for (const [value, name] of [
    [input.ssrc, 'RTCP SSRC'],
    [input.ntp_seconds, 'RTCP NTP seconds'],
    [input.ntp_fraction, 'RTCP NTP fraction'],
    [input.rtp_timestamp, 'RTCP RTP timestamp'],
    [input.packet_count, 'RTCP packet count'],
    [input.octet_count, 'RTCP octet count']
  ] as const) {
    uint(value, 0xffff_ffff, name);
  }
  const packet = Buffer.allocUnsafe(28);
  packet[0] = 0x80;
  packet[1] = 200;
  packet.writeUInt16BE(6, 2);
  packet.writeUInt32BE(input.ssrc, 4);
  packet.writeUInt32BE(input.ntp_seconds, 8);
  packet.writeUInt32BE(input.ntp_fraction, 12);
  packet.writeUInt32BE(input.rtp_timestamp, 16);
  packet.writeUInt32BE(input.packet_count, 20);
  packet.writeUInt32BE(input.octet_count, 24);
  return packet;
}

export function parseRtcpPacket(packet: Buffer): ParsedRtcpPacket {
  if (!Buffer.isBuffer(packet) || packet.length < 8) {
    throw new Error('RTCP packet is truncated');
  }
  const version = packet[0]! >>> 6;
  const reportCount = packet[0]! & 0x1f;
  const packetType = packet[1]!;
  const packetBytes = (packet.readUInt16BE(2) + 1) * 4;
  if (version !== 2 || packetBytes > packet.length || packetBytes < 8) {
    throw new Error('RTCP packet is invalid');
  }
  const parsed: ParsedRtcpPacket = {
    version,
    packet_type: packetType,
    report_count: reportCount,
    ssrc: packet.readUInt32BE(4)
  };
  if (packetType === 200) {
    if (packetBytes < 28) throw new Error('RTCP sender report is truncated');
    parsed.packet_count = packet.readUInt32BE(20);
    parsed.octet_count = packet.readUInt32BE(24);
  }
  return parsed;
}

export function parseRelayEndpoint(sdp: string): RelayEndpoint {
  if (typeof sdp !== 'string' || Buffer.byteLength(sdp, 'utf8') > 256 * 1024) {
    throw new Error('SDP is invalid');
  }
  const lines = sdp.split(/\r?\n/).filter(Boolean);
  let sessionAddress = '';
  let audioIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('c=') && audioIndex < 0) {
      sessionAddress = connectionAddress(line);
    }
    if (line.startsWith('m=audio ')) {
      audioIndex = index;
      break;
    }
  }
  if (audioIndex < 0) throw new Error('SDP audio media is missing');
  const media = lines[audioIndex]!.slice(2).trim().split(/\s+/);
  if (media.length < 4) throw new Error('SDP audio media is invalid');
  const port = boundedInteger(Number(media[1]), 1, 65_535, 'SDP audio port');
  const profile = media[2]!;
  if (!/^[A-Z0-9/.-]{1,32}$/i.test(profile)) {
    throw new Error('SDP RTP profile is invalid');
  }
  const payloadTypes = media.slice(3).map((value) =>
    boundedInteger(Number(value), 0, 127, 'SDP payload type')
  );
  let mediaAddress = '';
  for (let index = audioIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith('m=')) break;
    if (line.startsWith('c=')) mediaAddress = connectionAddress(line);
  }
  const address = mediaAddress || sessionAddress;
  if (!address) throw new Error('SDP connection address is missing');
  return { address, port, profile, payload_types: payloadTypes };
}

export function createSdesKeyMaterial(
  masterKey: Buffer = randomBytes(16),
  masterSalt: Buffer = randomBytes(14)
): SdesKeyMaterial {
  if (!Buffer.isBuffer(masterKey) ||
      masterKey.length !== 16 ||
      !Buffer.isBuffer(masterSalt) ||
      masterSalt.length !== 14) {
    throw new Error('SDES SRTP key material is invalid');
  }
  const key = Buffer.from(masterKey);
  const salt = Buffer.from(masterSalt);
  return {
    suite: 'AES_CM_128_HMAC_SHA1_80',
    master_key: key,
    master_salt: salt,
    inline_key: Buffer.concat([key, salt]).toString('base64')
  };
}

export function buildEndpointSdp(input: {
  address: string;
  port: number;
  session_id: string;
  ssrc: number;
  mode: 'rtp' | 'sdes_srtp';
  key_material?: SdesKeyMaterial;
}): string {
  if (isIP(input.address) === 0) {
    throw new Error('SDP endpoint address is invalid');
  }
  const port = boundedInteger(input.port, 1, 65_535, 'SDP endpoint port');
  if (!/^[1-9][0-9]{0,19}$/.test(input.session_id)) {
    throw new Error('SDP session ID is invalid');
  }
  const ssrc = uint(input.ssrc, 0xffff_ffff, 'SDP SSRC');
  if (input.mode !== 'rtp' && input.mode !== 'sdes_srtp') {
    throw new Error('SDP media mode is invalid');
  }
  if (input.mode === 'sdes_srtp' && !input.key_material) {
    throw new Error('SDES key material is required');
  }
  if (input.mode === 'rtp' && input.key_material) {
    throw new Error('SDES key material is not allowed for RTP');
  }
  const family = isIP(input.address) === 4 ? 'IP4' : 'IP6';
  const profile = input.mode === 'rtp' ? 'RTP/AVP' : 'RTP/SAVP';
  const lines = [
    'v=0',
    `o=- ${input.session_id} 1 IN ${family} ${input.address}`,
    's=ivekit-rtpengine-acceptance',
    `c=IN ${family} ${input.address}`,
    't=0 0',
    `m=audio ${port} ${profile} 0`,
    'a=rtpmap:0 PCMU/8000',
    'a=ptime:20',
    'a=rtcp-mux',
    'a=sendrecv',
    `a=ssrc:${ssrc} cname:ivekit-${input.session_id}`
  ];
  if (input.key_material) {
    const checked = checkedSdesKeyMaterial(input.key_material);
    lines.splice(
      lines.length - 2,
      0,
      `a=crypto:1 ${checked.suite} inline:${checked.inline_key}`
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function parseSdesCrypto(sdp: string): SdesKeyMaterial {
  if (typeof sdp !== 'string' || Buffer.byteLength(sdp, 'utf8') > 256 * 1024) {
    throw new Error('SDP is invalid');
  }
  const cryptoLines = sdp.split(/\r?\n/).filter((line) =>
    /^a=crypto:\d+\s/.test(line)
  );
  const compatible = cryptoLines.find((line) =>
    /^a=crypto:\d+\s+AES_CM_128_HMAC_SHA1_80\s+inline:/.test(line)
  );
  if (!compatible) throw new Error('SDES SRTP crypto attribute is missing');
  const match = compatible.match(
    /^a=crypto:\d+\s+AES_CM_128_HMAC_SHA1_80\s+inline:([A-Za-z0-9+/]+={0,2})(?:\|[^\s]+)?(?:\s|$)/
  );
  if (!match) throw new Error('SDES SRTP crypto attribute is invalid');
  const inlineKey = match[1]!;
  const decoded = Buffer.from(inlineKey, 'base64');
  if (decoded.length !== 30 ||
      decoded.toString('base64') !== inlineKey) {
    throw new Error('SDES SRTP inline key is invalid');
  }
  return createSdesKeyMaterial(
    decoded.subarray(0, 16),
    decoded.subarray(16)
  );
}

export function createSdesSrtpContext(input: {
  suite: 'AES_CM_128_HMAC_SHA1_80';
  master_key: Buffer;
  master_salt: Buffer;
  ssrc: number;
}): SdesSrtpContext {
  if (input.suite !== 'AES_CM_128_HMAC_SHA1_80' ||
      !Buffer.isBuffer(input.master_key) ||
      input.master_key.length !== 16 ||
      !Buffer.isBuffer(input.master_salt) ||
      input.master_salt.length !== 14) {
    throw new Error('SDES SRTP key material is invalid');
  }
  const ssrc = uint(input.ssrc, 0xffff_ffff, 'SRTP SSRC');
  return {
    suite: input.suite,
    ssrc,
    encryption_key: deriveSrtpKey(input.master_key, input.master_salt, 0, 16),
    authentication_key: deriveSrtpKey(
      input.master_key,
      input.master_salt,
      1,
      20
    ),
    session_salt: deriveSrtpKey(input.master_key, input.master_salt, 2, 14),
    send_rollover_counter: 0,
    send_last_sequence: null,
    receive_rollover_counter: 0,
    receive_last_sequence: null,
    receive_highest_index: -1
  };
}

export function protectSrtpPacket(
  context: SdesSrtpContext,
  plaintextPacket: Buffer
): Buffer {
  const parsed = parseRtpPacket(plaintextPacket);
  assertContextPacket(context, parsed);
  const rolloverCounter = advanceSendRollover(context, parsed.sequence);
  const packetIndex = rolloverCounter * RTP_SEQUENCE_MODULUS + parsed.sequence;
  const protectedPacket = Buffer.from(plaintextPacket);
  const cipher = createCipheriv(
    'aes-128-ctr',
    context.encryption_key,
    srtpIv(context.session_salt, context.ssrc, packetIndex)
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintextPacket.subarray(parsed.header_bytes)),
    cipher.final()
  ]);
  encrypted.copy(protectedPacket, parsed.header_bytes);
  const rollover = Buffer.allocUnsafe(4);
  rollover.writeUInt32BE(rolloverCounter);
  const authentication = createHmac('sha1', context.authentication_key)
    .update(protectedPacket)
    .update(rollover)
    .digest()
    .subarray(0, SRTP_AUTH_TAG_BYTES);
  return Buffer.concat([protectedPacket, authentication]);
}

export function unprotectSrtpPacket(
  context: SdesSrtpContext,
  protectedPacket: Buffer
): Buffer {
  if (!Buffer.isBuffer(protectedPacket) ||
      protectedPacket.length < RTP_FIXED_HEADER_BYTES + SRTP_AUTH_TAG_BYTES + 1) {
    throw new Error('SRTP packet is truncated');
  }
  const authenticatedBytes = protectedPacket.subarray(
    0,
    protectedPacket.length - SRTP_AUTH_TAG_BYTES
  );
  const suppliedTag = protectedPacket.subarray(-SRTP_AUTH_TAG_BYTES);
  const parsed = parseRtpPacket(authenticatedBytes);
  assertContextPacket(context, parsed);
  const rolloverCounter = estimateReceiveRollover(context, parsed.sequence);
  const rollover = Buffer.allocUnsafe(4);
  rollover.writeUInt32BE(rolloverCounter);
  const expectedTag = createHmac('sha1', context.authentication_key)
    .update(authenticatedBytes)
    .update(rollover)
    .digest()
    .subarray(0, SRTP_AUTH_TAG_BYTES);
  if (!timingSafeEqual(suppliedTag, expectedTag)) {
    throw new Error('SRTP authentication failed');
  }
  const packetIndex = rolloverCounter * RTP_SEQUENCE_MODULUS + parsed.sequence;
  const plaintext = Buffer.from(authenticatedBytes);
  const cipher = createCipheriv(
    'aes-128-ctr',
    context.encryption_key,
    srtpIv(context.session_salt, context.ssrc, packetIndex)
  );
  const decrypted = Buffer.concat([
    cipher.update(authenticatedBytes.subarray(parsed.header_bytes)),
    cipher.final()
  ]);
  decrypted.copy(plaintext, parsed.header_bytes);
  if (packetIndex > context.receive_highest_index) {
    context.receive_rollover_counter = rolloverCounter;
    context.receive_last_sequence = parsed.sequence;
    context.receive_highest_index = packetIndex;
  }
  return plaintext;
}

function deriveSrtpKey(
  masterKey: Buffer,
  masterSalt: Buffer,
  label: number,
  length: number
): Buffer {
  const initializationVector = Buffer.alloc(16);
  masterSalt.copy(initializationVector);
  initializationVector[7] = initializationVector[7]! ^ label;
  const cipher = createCipheriv('aes-128-ctr', masterKey, initializationVector);
  return Buffer.concat([
    cipher.update(Buffer.alloc(length)),
    cipher.final()
  ]).subarray(0, length);
}

function srtpIv(
  sessionSalt: Buffer,
  ssrc: number,
  packetIndex: number
): Buffer {
  if (!Number.isSafeInteger(packetIndex) ||
      packetIndex < 0 ||
      packetIndex > 0xffff_ffff_ffff) {
    throw new Error('SRTP packet index is invalid');
  }
  const initializationVector = Buffer.alloc(16);
  sessionSalt.copy(initializationVector);
  initializationVector[4] ^= (ssrc >>> 24) & 0xff;
  initializationVector[5] ^= (ssrc >>> 16) & 0xff;
  initializationVector[6] ^= (ssrc >>> 8) & 0xff;
  initializationVector[7] ^= ssrc & 0xff;
  let remaining = packetIndex;
  for (let index = 13; index >= 8; index -= 1) {
    initializationVector[index] ^= remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return initializationVector;
}

function advanceSendRollover(
  context: SdesSrtpContext,
  sequence: number
): number {
  if (context.send_last_sequence !== null &&
      context.send_last_sequence > 0xc000 &&
      sequence < 0x4000) {
    context.send_rollover_counter += 1;
  }
  context.send_last_sequence = sequence;
  return context.send_rollover_counter;
}

function estimateReceiveRollover(
  context: SdesSrtpContext,
  sequence: number
): number {
  const last = context.receive_last_sequence;
  if (last === null) return context.receive_rollover_counter;
  if (last < 0x8000 && sequence - last > 0x8000) {
    return Math.max(0, context.receive_rollover_counter - 1);
  }
  if (last >= 0x8000 && last - 0x8000 > sequence) {
    return context.receive_rollover_counter + 1;
  }
  return context.receive_rollover_counter;
}

function assertContextPacket(
  context: SdesSrtpContext,
  packet: ParsedRtpPacket
): void {
  if (context.suite !== 'AES_CM_128_HMAC_SHA1_80' ||
      packet.ssrc !== context.ssrc) {
    throw new Error('SRTP context does not match packet');
  }
}

function checkedSdesKeyMaterial(input: SdesKeyMaterial): SdesKeyMaterial {
  const material = createSdesKeyMaterial(input.master_key, input.master_salt);
  if (input.suite !== material.suite ||
      input.inline_key !== material.inline_key) {
    throw new Error('SDES SRTP key material is inconsistent');
  }
  return material;
}

function connectionAddress(line: string): string {
  const fields = line.slice(2).trim().split(/\s+/);
  if (fields.length !== 3 ||
      fields[0] !== 'IN' ||
      !['IP4', 'IP6'].includes(fields[1]!)) {
    throw new Error('SDP connection line is invalid');
  }
  const address = fields[2]!.split('/', 1)[0]!;
  if (isIP(address) === 0) throw new Error('SDP connection address is invalid');
  return address;
}

function checkedEndpoint(input: {
  address: string;
  port: number;
}): { address: string; port: number } {
  if (!input || isIP(input.address) === 0) {
    throw new Error('RTP target address is invalid');
  }
  return {
    address: input.address,
    port: boundedInteger(input.port, 1, 65_535, 'RTP target port')
  };
}

function sendDatagram(
  socket: Socket,
  packet: Buffer,
  target: { address: string; port: number }
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, target.port, target.address, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isRtcp(packet: Buffer): boolean {
  if (packet.length < 2 || packet[0]! >>> 6 !== 2) return false;
  const packetType = packet[1]!;
  return packetType >= 192 && packetType <= 223;
}

function uint(value: number, maximum: number, label: string): number {
  return boundedInteger(value, 0, maximum, label);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
