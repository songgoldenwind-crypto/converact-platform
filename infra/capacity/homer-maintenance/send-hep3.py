#!/usr/bin/env python3
"""Send bounded HEPv3 SIP fixtures with an explicit capture timestamp."""

from __future__ import annotations

import argparse
import re
import socket
import struct
import time


MAX_PACKETS = 100_000
MIN_OFFSET_SECONDS = -(10 * 366 * 24 * 60 * 60)
MAX_OFFSET_SECONDS = 300
PREFIX_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$")


def chunk(vendor: int, type_id: int, body: bytes) -> bytes:
    return struct.pack(">HHH", vendor, type_id, 6 + len(body)) + body


def build_hep3(
    sip: str,
    *,
    src_ip: str,
    dst_ip: str,
    src_port: int,
    dst_port: int,
    capture_id: int,
    correlation_id: str,
    captured_at: float,
) -> bytes:
    seconds = int(captured_at)
    microseconds = int((captured_at - seconds) * 1_000_000)
    body = b"".join(
        (
            chunk(0, 0x0001, struct.pack("B", 2)),
            chunk(0, 0x0002, struct.pack("B", 17)),
            chunk(0, 0x0003, socket.inet_aton(src_ip)),
            chunk(0, 0x0004, socket.inet_aton(dst_ip)),
            chunk(0, 0x0007, struct.pack(">H", src_port)),
            chunk(0, 0x0008, struct.pack(">H", dst_port)),
            chunk(0, 0x0009, struct.pack(">I", seconds)),
            chunk(0, 0x000A, struct.pack(">I", microseconds)),
            chunk(0, 0x000B, struct.pack("B", 1)),
            chunk(0, 0x000C, struct.pack(">I", capture_id & 0xFFFFFFFF)),
            chunk(0, 0x000F, sip.encode("utf-8")),
            chunk(0, 0x0011, correlation_id.encode("utf-8")),
        )
    )
    return b"HEP3" + struct.pack(">H", 6 + len(body)) + body


def sip_payload(call_id: str) -> str:
    return (
        "INVITE sip:bob@example.test SIP/2.0\r\n"
        "Via: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK-maintenance\r\n"
        "From: <sip:alice@example.test>;tag=maintenance\r\n"
        "To: <sip:bob@example.test>\r\n"
        f"Call-ID: {call_id}\r\n"
        "CSeq: 1 INVITE\r\n"
        "Contact: <sip:alice@10.0.0.1:5060>\r\n"
        "Content-Length: 0\r\n\r\n"
    )


def parse_chunks(packet: bytes) -> dict[int, bytes]:
    if packet[:4] != b"HEP3" or len(packet) < 6:
        raise ValueError("invalid HEPv3 header")
    declared = struct.unpack(">H", packet[4:6])[0]
    if declared != len(packet):
        raise ValueError("invalid HEPv3 length")
    chunks: dict[int, bytes] = {}
    offset = 6
    while offset < len(packet):
        if offset + 6 > len(packet):
            raise ValueError("truncated HEPv3 chunk")
        _, type_id, length = struct.unpack(">HHH", packet[offset : offset + 6])
        if length < 6 or offset + length > len(packet):
            raise ValueError("invalid HEPv3 chunk length")
        chunks[type_id] = packet[offset + 6 : offset + length]
        offset += length
    return chunks


def self_test() -> None:
    captured_at = 1_700_000_000.125
    call_id = "maintenance-self-test-1"
    packet = build_hep3(
        sip_payload(call_id),
        src_ip="10.0.0.1",
        dst_ip="10.0.0.2",
        src_port=5060,
        dst_port=5060,
        capture_id=7,
        correlation_id=call_id,
        captured_at=captured_at,
    )
    chunks = parse_chunks(packet)
    assert struct.unpack(">I", chunks[0x0009])[0] == 1_700_000_000
    assert struct.unpack(">I", chunks[0x000A])[0] == 125_000
    assert chunks[0x0011].decode() == call_id
    assert f"Call-ID: {call_id}\r\n".encode() in chunks[0x000F]
    print("HEPv3 self-test passed")


def bounded_integer(name: str, value: int, minimum: int, maximum: int) -> int:
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--udp", metavar="HOST:PORT")
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--prefix", default="homer-maintenance")
    parser.add_argument("--timestamp-offset-seconds", type=int, default=0)
    parser.add_argument("--capture-id-base", type=int, default=20_000)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return
    if not args.udp:
        parser.error("--udp is required")
    if not PREFIX_PATTERN.fullmatch(args.prefix):
        parser.error("--prefix has an invalid format")
    try:
        count = bounded_integer("count", args.count, 1, MAX_PACKETS)
        offset = bounded_integer(
            "timestamp offset",
            args.timestamp_offset_seconds,
            MIN_OFFSET_SECONDS,
            MAX_OFFSET_SECONDS,
        )
        capture_id_base = bounded_integer(
            "capture id base", args.capture_id_base, 1, 0xFFFFFFFF - count
        )
    except ValueError as error:
        parser.error(str(error))

    host, port_text = args.udp.rsplit(":", 1)
    port = bounded_integer("UDP port", int(port_text), 1, 65_535)
    captured_at = time.time() + offset
    sent = 0
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
        for sequence in range(count):
            call_id = f"{args.prefix}-{sequence}"
            packet = build_hep3(
                sip_payload(call_id),
                src_ip="10.0.0.1",
                dst_ip="10.0.0.2",
                src_port=5060,
                dst_port=5060,
                capture_id=capture_id_base + sequence,
                correlation_id=call_id,
                captured_at=captured_at + (sequence / 1_000_000),
            )
            sender.sendto(packet, (host, port))
            sent += 1
    print(f"sent={sent} prefix={args.prefix} timestamp_offset_seconds={offset}")


if __name__ == "__main__":
    main()
