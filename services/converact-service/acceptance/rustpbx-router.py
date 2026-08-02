import hmac
import json
import os
import re
from email.parser import BytesParser
from email.policy import default as email_policy
from http.server import BaseHTTPRequestHandler, HTTPServer


MAX_BODY_BYTES = 1024 * 1024
WEBHOOK_TOKEN = os.environ["RUSTPBX_WEBHOOK_TOKEN"]
EVIDENCE = {"router_requests": 0, "cdr_requests": 0}
FORWARD_ROUTES = {
    "18005550200": ("sip:uas@172.30.44.22:5060", 30),
    "18005550201": ("sip:uas@172.30.44.23:5060", 30),
    "18005550202": ("sip:uas@172.30.44.24:5060", 30),
    "18005550203": ("sip:uas@172.30.44.25:5060", 30),
    "18005550204": ("sip:uas@172.30.44.26:5060", 30),
    "18005550205": ("sip:uas@172.30.44.27:5060;transport=tcp", 30),
    "18005550206": ("sip:uas@172.30.44.28:5060", 30),
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"status": "ok"})
            return
        if self.path == "/evidence":
            if not self.authorized():
                self.respond(401, {"error": "unauthorized"})
                return
            self.respond(200, dict(EVIDENCE))
            return
        self.respond(404, {"error": "not_found"})

    def do_POST(self):
        if not self.authorized():
            self.respond(401, {"error": "unauthorized"})
            return
        if self.path == "/router":
            try:
                payload = self.read_json()
            except ValueError as error:
                self.respond(422, {"error": str(error)})
                return
            required = ("call_id", "from", "to", "direction", "method", "uri")
            if any(not isinstance(payload.get(name), str) or not payload[name] for name in required):
                self.respond(422, {"error": "invalid_router_payload"})
                return
            EVIDENCE["router_requests"] += 1
            destination = sip_user(payload["to"])
            route = FORWARD_ROUTES.get(destination)
            if route:
                target, max_ring_time = route
                self.respond(200, {
                    "action": "forward",
                    "targets": [target],
                    "strategy": "sequential",
                    "record": False,
                    "timeout": 30,
                    "max_ring_time": max_ring_time,
                })
                return
            self.respond(200, {"action": "reject", "status": 486, "reason": "acceptance-route"})
            return
        if self.path == "/cdr":
            try:
                self.read_call_record()
            except ValueError as error:
                self.respond(422, {"error": str(error)})
                return
            EVIDENCE["cdr_requests"] += 1
            self.respond(200, {"status": "accepted"})
            return
        self.respond(404, {"error": "not_found"})

    def read_json(self):
        try:
            payload = json.loads(self.read_body())
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError("invalid_json") from error
        if not isinstance(payload, dict):
            raise ValueError("invalid_json_object")
        return payload

    def read_call_record(self):
        content_type = self.headers.get("content-type", "")
        if not content_type.lower().startswith("multipart/form-data;"):
            raise ValueError("invalid_cdr_content_type")
        message = BytesParser(policy=email_policy).parsebytes(
            f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("ascii") + self.read_body()
        )
        for part in message.iter_parts():
            if part.get_param("name", header="content-disposition") != "calllog.json":
                continue
            content = part.get_content()
            if isinstance(content, bytes):
                content = content.decode("utf-8")
            try:
                payload = json.loads(content)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ValueError("invalid_cdr_json") from error
            required_strings = ("callId", "caller", "callee")
            if not isinstance(payload, dict) or any(
                not isinstance(payload.get(name), str) or not payload[name] for name in required_strings
            ) or not isinstance(payload.get("statusCode"), int):
                raise ValueError("invalid_cdr_payload")
            return payload
        raise ValueError("missing_cdr_part")

    def read_body(self):
        raw_length = self.headers.get("content-length", "")
        if not raw_length.isdigit():
            raise ValueError("invalid_content_length")
        length = int(raw_length)
        if length < 2 or length > MAX_BODY_BYTES:
            raise ValueError("invalid_body_size")
        return self.rfile.read(length)

    def authorized(self):
        return hmac.compare_digest(self.headers.get("X-PBX-Key", ""), WEBHOOK_TOKEN)

    def log_message(self, _format, *_args):
        return

    def respond(self, status, body):
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def sip_user(value):
    match = re.search(r"sip:([^@;>]+)", value, re.IGNORECASE)
    user = match.group(1) if match else ""
    return user[1:] if user.startswith("+") else user


HTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
