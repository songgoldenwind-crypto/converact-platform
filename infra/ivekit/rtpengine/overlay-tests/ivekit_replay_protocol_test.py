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

    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.settimeout(5)
        first = send(sock, (host, port), first_cookie, command)
        cached = send(sock, (host, port), first_cookie, command)
        rejected = send(sock, (host, port), second_cookie, command)

    if b"6:result2:ok" not in first:
        raise AssertionError(f"initial command failed: {first!r}")
    if cached != first:
        raise AssertionError("stable-cookie replay did not return cached response")
    if b"ivekit command already applied" not in rejected:
        raise AssertionError(f"cross-cookie replay was not rejected: {rejected!r}")

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
        "cross_cookie_replayed": int(replayed),
        "cross_cookie_result": "rejected_without_dispatch",
        "stable_cookie_result": "cached",
    }, sort_keys=True))


if __name__ == "__main__":
    main()
