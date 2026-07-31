#!/usr/bin/env python3

import json
import os
import re
import socket
import urllib.request


def bencode(value):
    if isinstance(value, bytes):
        return str(len(value)).encode() + b":" + value
    if isinstance(value, str):
        return bencode(value.encode())
    if isinstance(value, dict):
        items = []
        for key in sorted(value):
            items.extend((bencode(key), bencode(value[key])))
        return b"d" + b"".join(items) + b"e"
    raise TypeError(f"unsupported bencode value: {type(value).__name__}")


def send(sock, address, cookie, command):
    sock.sendto(cookie + b" " + bencode(command), address)
    response, _ = sock.recvfrom(1_048_576)
    if not response.startswith(cookie + b" "):
        raise AssertionError("RTPengine response cookie mismatch")
    return response


def metric_value(metrics, labels):
    pattern = (
        r"ivekit_guard_events_total\{"
        + re.escape(labels)
        + r"\}\s+([0-9]+(?:\.[0-9]+)?)"
    )
    match = re.search(pattern, metrics)
    if not match:
        raise AssertionError(f"metric not found: {labels}")
    return float(match.group(1))


def gauge_value(metrics, name, labels):
    pattern = (
        r"^"
        + re.escape(name)
        + r"\{"
        + re.escape(labels)
        + r"\}\s+([0-9]+(?:\.[0-9]+)?)$"
    )
    match = re.search(pattern, metrics, re.MULTILINE)
    if not match:
        raise AssertionError(f"metric not found: {name}{{{labels}}}")
    return float(match.group(1))


def main():
    host = os.environ.get("IVEKIT_RTPENGINE_TEST_HOST", "127.0.0.1")
    port = int(os.environ.get("IVEKIT_RTPENGINE_TEST_PORT", "22222"))
    metrics_url = os.environ.get(
        "IVEKIT_RTPENGINE_METRICS_URL",
        f"http://{host}:8080/metrics",
    )
    command = {
        "call-id": "ivekit-replay-protocol-test",
        "command": "offer",
        "from-tag": "ivekit-test-a",
        "ivekit-command-hash": "a" * 64,
        "ivekit-command-id": "ivekit-test-command-1",
        "ivekit-command-sequence": "1",
        "ivekit-owner-epoch": "1",
        "ivekit-reservation-id": "ivekit-test-reservation",
        "sdp": (
            "v=0\r\n"
            "o=- 1 1 IN IP4 192.0.2.10\r\n"
            "s=-\r\n"
            "c=IN IP4 192.0.2.10\r\n"
            "t=0 0\r\n"
            "m=audio 4000 RTP/AVP 0\r\n"
            "a=rtpmap:0 PCMU/8000\r\n"
            "a=sendrecv\r\n"
        ),
    }
    first_cookie = b"ivekit-replay-cookie-1"
    second_cookie = b"ivekit-replay-cookie-2"
    raw_query = {
        "call-id": command["call-id"],
        "command": "query",
    }
    guarded_query = {
        **raw_query,
        "ivekit-command-hash": "b" * 64,
        "ivekit-command-id": "ivekit-test-command-2",
        "ivekit-command-sequence": "2",
        "ivekit-owner-epoch": "1",
        "ivekit-reservation-id": "ivekit-test-reservation",
    }
    replay_ack = {
        "call-id": command["call-id"],
        "command": "ivekit replay ack",
        "ivekit-ack-command-hash": command["ivekit-command-hash"],
        "ivekit-ack-command-id": command["ivekit-command-id"],
    }
    command_status = {
        "call-id": command["call-id"],
        "command": "ivekit command status",
        "ivekit-status-command-hash": command["ivekit-command-hash"],
        "ivekit-status-command-id": command["ivekit-command-id"],
        "ivekit-status-command-sequence": command["ivekit-command-sequence"],
        "ivekit-status-owner-epoch": command["ivekit-owner-epoch"],
        "ivekit-status-reservation-id": command["ivekit-reservation-id"],
    }
    next_command_status = {
        **command_status,
        "ivekit-status-command-hash": guarded_query["ivekit-command-hash"],
        "ivekit-status-command-id": guarded_query["ivekit-command-id"],
        "ivekit-status-command-sequence": guarded_query[
            "ivekit-command-sequence"
        ],
    }
    conflicting_status = {
        **command_status,
        "ivekit-status-command-hash": "f" * 64,
        "ivekit-status-command-id": "ivekit-conflicting-command",
    }
    blocked = {
        "call-id": command["call-id"],
        "command": "block media",
        "from-tag": "ivekit-test-a",
        "ivekit-command-hash": "c" * 64,
        "ivekit-command-id": "ivekit-test-command-3",
        "ivekit-command-sequence": "3",
        "ivekit-owner-epoch": "1",
        "ivekit-reservation-id": "ivekit-test-reservation",
    }

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(5)
        first = send(sock, (host, port), first_cookie, command)
        cached = send(sock, (host, port), first_cookie, command)
        rejected = send(sock, (host, port), second_cookie, command)
        applied_status = send(
            sock, (host, port), b"ivekit-status-applied-cookie", command_status
        )
        unseen_status = send(
            sock, (host, port), b"ivekit-status-unseen-cookie",
            next_command_status
        )
        conflict_status = send(
            sock, (host, port), b"ivekit-status-conflict-cookie",
            conflicting_status
        )
        acknowledged = send(
            sock, (host, port), b"ivekit-replay-ack-cookie", replay_ack
        )
        with urllib.request.urlopen(metrics_url, timeout=5) as response:
            ack_metrics = response.read().decode()
        recovered = send(
            sock, (host, port), b"ivekit-raw-query-cookie", raw_query
        )
        queried = send(
            sock, (host, port), b"ivekit-guarded-query-cookie", guarded_query
        )
        media_blocked = send(
            sock, (host, port), b"ivekit-block-cookie", blocked
        )

    if b"6:result2:ok" not in first:
        raise AssertionError(f"initial command failed: {first!r}")
    if cached != first:
        raise AssertionError("stable-cookie replay did not return cached response")
    if b"ivekit command already applied" not in rejected:
        raise AssertionError(f"cross-cookie replay was not rejected: {rejected!r}")
    if b"23:ivekit-command-replayedi1e" not in rejected:
        raise AssertionError(f"cross-cookie replay marker missing: {rejected!r}")
    if b"3:sdp" not in rejected or b"v=0\r\n" not in rejected:
        raise AssertionError(f"cross-cookie replay SDP missing: {rejected!r}")
    if (
        b"21:ivekit-command-status7:applied" not in applied_status
        or b"3:sdp" not in applied_status
        or b"v=0\r\n" not in applied_status
    ):
        raise AssertionError(
            f"exact applied command status missing: {applied_status!r}"
        )
    if (
        b"21:ivekit-command-status6:unseen" not in unseen_status
        or b"24:ivekit-guard-entry-foundi1e" not in unseen_status
    ):
        raise AssertionError(
            f"next command status was not unseen: {unseen_status!r}"
        )
    if b"21:ivekit-command-status8:conflict" not in conflict_status:
        raise AssertionError(
            f"conflicting command status was not fenced: {conflict_status!r}"
        )
    ack_marker = bencode("ivekit-replay-acknowledged") + b"i1e"
    if b"6:result2:ok" not in acknowledged or ack_marker not in acknowledged:
        raise AssertionError(f"replay SDP acknowledgement failed: {acknowledged!r}")
    replay_sdp_bytes = gauge_value(
        ack_metrics,
        "rtpengine_ivekit_replay_sdp_bytes",
        'runtime_mode="userspace"',
    )
    replay_sdp_limit = gauge_value(
        ack_metrics,
        "rtpengine_ivekit_replay_sdp_byte_limit",
        'runtime_mode="userspace"',
    )
    if replay_sdp_bytes != 0 or replay_sdp_limit < 256 * 1024:
        raise AssertionError(
            "unexpected replay SDP budget after ack: "
            f"bytes={replay_sdp_bytes}, limit={replay_sdp_limit}"
        )
    if b"6:result2:ok" not in recovered:
        raise AssertionError(f"raw recovery query was fenced: {recovered!r}")
    if b"6:result2:ok" not in queried or b"23:ivekit-command-sequencei2e" not in queried:
        raise AssertionError(f"guarded query did not advance sequence: {queried!r}")
    if b"6:result2:ok" not in media_blocked or b"23:ivekit-command-sequencei3e" not in media_blocked:
        raise AssertionError(
            f"post-query media mutation hit a sequence gap: {media_blocked!r}"
        )

    with urllib.request.urlopen(metrics_url, timeout=5) as response:
        metrics = response.read().decode()
    accepted = metric_value(
        metrics,
        'command="admission",result="accepted",runtime_mode="userspace"',
    )
    replayed = metric_value(
        metrics,
        'command="mutation",result="replayed",runtime_mode="userspace"',
    )
    if accepted != 1 or replayed != 1:
        raise AssertionError(
            f"unexpected replay counters: accepted={accepted}, replayed={replayed}"
        )

    print(json.dumps({
        "accepted": int(accepted),
        "command_status": "applied_unseen_conflict",
        "cross_cookie_replayed": int(replayed),
        "cross_cookie_result": "fenced_replay_with_sdp",
        "guarded_query_sequence": 2,
        "post_query_mutation_sequence": 3,
        "raw_recovery_query": "unfenced",
        "replay_sdp_ack": "released",
        "stable_cookie_result": "cached",
    }, sort_keys=True))


if __name__ == "__main__":
    main()
