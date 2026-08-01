#!/usr/bin/env python3
import os
import re
import secrets
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
PLACEHOLDER = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


def required_image(name: str, digest_required: bool) -> str:
    value = os.environ.get(name, "").strip()
    if not value or any(character.isspace() for character in value):
        raise SystemExit(f"{name} is required")
    if digest_required and not re.search(r"@sha256:[a-f0-9]{64}$", value):
        raise SystemExit(f"{name} must be pinned by SHA-256 digest")
    if name in {"RUSTPBX_IMAGE", "KAMAILIO_IMAGE"} and not (
        re.search(r"@sha256:[a-f0-9]{64}$", value)
        or re.search(r":\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$", value)
    ):
        raise SystemExit(f"{name} must use an immutable digest or exact version tag")
    return value


def bounded_integer(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    if not raw.isdigit():
        raise SystemExit(f"{name} must be an integer")
    value = int(raw)
    if value < minimum or value > maximum:
        raise SystemExit(f"{name} must be between {minimum} and {maximum}")
    return value


def shared_memory_allocator() -> str:
    value = os.environ.get("KAMAILIO_SHM_ALLOCATOR", "fm").strip().lower()
    if value not in {"fm", "qm", "tlsf"}:
        raise SystemExit("KAMAILIO_SHM_ALLOCATOR must be fm, qm, or tlsf")
    return value


def media_proxy_mode() -> str:
    value = os.environ.get("RUSTPBX_MEDIA_PROXY_MODE", "auto").strip().lower()
    if value not in {"all", "auto", "nat", "none", "bypass"}:
        raise SystemExit(
            "RUSTPBX_MEDIA_PROXY_MODE must be all, auto, nat, none, or bypass"
        )
    return value


def rtp_port_range() -> dict[str, int]:
    start = bounded_integer("RUSTPBX_RTP_START_PORT", 20000, 1024, 65534)
    end = bounded_integer("RUSTPBX_RTP_END_PORT", 40000, 1024, 65534)
    if start % 2 != 0:
        raise SystemExit("RUSTPBX_RTP_START_PORT must be even")
    if end % 2 != 0:
        raise SystemExit("RUSTPBX_RTP_END_PORT must be even")
    if start >= end:
        raise SystemExit("RustPBX RTP port range must have start below end")
    return {
        "RUSTPBX_RTP_START_PORT": start,
        "RUSTPBX_RTP_END_PORT": end,
    }


def write_private(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o600)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: prepare.py OUTPUT_DIRECTORY")
    output = Path(sys.argv[1]).resolve()
    output.mkdir(parents=True, exist_ok=True)

    images = {
        "RUSTPBX_IMAGE": required_image("RUSTPBX_IMAGE", False),
        "KAMAILIO_IMAGE": required_image("KAMAILIO_IMAGE", False),
        "POSTGRES_IMAGE": required_image("POSTGRES_IMAGE", True),
        "PYTHON_IMAGE": required_image("PYTHON_IMAGE", True),
        "CAPACITY_TOOLS_IMAGE": required_image("CAPACITY_TOOLS_IMAGE", False),
    }
    runtime = {
        "RUSTPBX_DB_PASSWORD": secrets.token_hex(32),
        "RUSTPBX_MANAGEMENT_TOKEN": secrets.token_urlsafe(36),
        "RUSTPBX_RWI_TOKEN": secrets.token_urlsafe(36),
        "RUSTPBX_WEBHOOK_TOKEN": secrets.token_urlsafe(36),
        "RUSTPBX_TRUNK_CREDENTIAL": secrets.token_urlsafe(36),
        "RUSTPBX_MEDIA_PROXY_MODE": media_proxy_mode(),
        "RUSTRTC_UDP_RECEIVE_BUFFER_BYTES": bounded_integer(
            "RUSTRTC_UDP_RECEIVE_BUFFER_BYTES", 1048576, 65536, 16777216
        ),
        "RUSTRTC_UDP_SEND_BUFFER_BYTES": bounded_integer(
            "RUSTRTC_UDP_SEND_BUFFER_BYTES", 524288, 65536, 16777216
        ),
        **rtp_port_range(),
    }
    kamailio_memory = {
        "KAMAILIO_SHM_ALLOCATOR": shared_memory_allocator(),
        "KAMAILIO_SHM_MEMORY_MB": bounded_integer(
            "KAMAILIO_SHM_MEMORY_MB", 512, 64, 4096
        ),
        "KAMAILIO_PKG_MEMORY_MB": bounded_integer(
            "KAMAILIO_PKG_MEMORY_MB", 32, 8, 256
        ),
    }
    kamailio_secrets = {
        "KAMAILIO_TOPOH_KEY_FILE": secrets.token_urlsafe(48),
        "KAMAILIO_RPC_TOKEN_FILE": secrets.token_urlsafe(48),
        "KAMAILIO_WEBPHONE_JWT_SECRET_FILE": secrets.token_urlsafe(48),
    }
    template = (ROOT / "rustpbx.toml.template").read_text(encoding="utf-8")
    config = PLACEHOLDER.sub(lambda match: str(runtime[match.group(1)]), template)
    if PLACEHOLDER.search(config):
        raise SystemExit("RustPBX config contains an unresolved placeholder")

    config_path = output / "rustpbx.toml"
    write_private(config_path, config)
    secret_paths = {}
    for name, value in kamailio_secrets.items():
        path = output / name.lower().replace("_file", "").replace("_", "-")
        write_private(path, value + "\n")
        secret_paths[name] = path

    kamailio_paths = {
        "KAMAILIO_CONFIG_FILE": output / "kamailio.cfg",
        "KAMAILIO_TLS_CONFIG_FILE": output / "tls.cfg",
        "KAMAILIO_DISPATCHER_FILE": output / "dispatcher.list",
        "KAMAILIO_TLS_KEY_FILE": output / "kamailio-tls-key.pem",
        "KAMAILIO_TLS_CERT_FILE": output / "kamailio-tls-cert.pem",
        "KAMAILIO_TLS_CA_FILE": output / "kamailio-tls-ca.pem",
        "CONVERACT_FABRIC_KAMAILIO_COMPOSE_CONFIG_OUTPUT": output / "kamailio-runtime.json",
        "CONVERACT_FABRIC_KAMAILIO_COMPOSE_TOPOLOGY_OUTPUT": output / "kamailio-topology.json",
    }
    env_lines = [
        "COMPOSE_PROJECT_NAME=converact-rustpbx-baseline",
        *(f"{name}={value}" for name, value in images.items()),
        *(f"{name}={value}" for name, value in runtime.items()),
        *(f"{name}={value}" for name, value in kamailio_memory.items()),
        f"RUSTPBX_CONFIG_FILE={config_path}",
        "RUSTPBX_ACCEPTANCE_TRUNK_IP=172.30.44.9",
        *(f"{name}={value}" for name, value in secret_paths.items()),
        *(f"{name}={value}" for name, value in kamailio_paths.items()),
        f"CONVERACT_FABRIC_KAMAILIO_CONFIG_FILE={kamailio_paths['CONVERACT_FABRIC_KAMAILIO_COMPOSE_CONFIG_OUTPUT']}",
        f"CONVERACT_FABRIC_KAMAILIO_TOPOH_KEY_FILE={secret_paths['KAMAILIO_TOPOH_KEY_FILE']}",
        f"CONVERACT_FABRIC_KAMAILIO_RPC_TOKEN_FILE={secret_paths['KAMAILIO_RPC_TOKEN_FILE']}",
        f"CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_SECRET_FILE={secret_paths['KAMAILIO_WEBPHONE_JWT_SECRET_FILE']}",
        "CONVERACT_FABRIC_KAMAILIO_WEBPHONE_JWT_RUNTIME_FILE=/run/secrets/kamailio-webphone-jwt-secret",
        f"CONVERACT_FABRIC_KAMAILIO_OUTPUT_FILE={kamailio_paths['KAMAILIO_CONFIG_FILE']}",
        f"CONVERACT_FABRIC_KAMAILIO_TLS_OUTPUT_FILE={kamailio_paths['KAMAILIO_TLS_CONFIG_FILE']}",
        "CONVERACT_FABRIC_KAMAILIO_TLS_RUNTIME_FILE=/etc/kamailio/tls.cfg",
        "CONVERACT_FABRIC_KAMAILIO_REGION_ID=capacity",
        "CONVERACT_FABRIC_KAMAILIO_ZONE_ID=zone-a",
        "CONVERACT_FABRIC_KAMAILIO_CELL_ID=cell-a",
        "CONVERACT_FABRIC_KAMAILIO_CELL_LEASE_EPOCH=1",
        "CONVERACT_FABRIC_KAMAILIO_PROFILE_ID=sip-kamailio-baseline",
        "CONVERACT_FABRIC_KAMAILIO_ADVERTISE_SIP_HOST=172.30.44.9",
        "CONVERACT_FABRIC_KAMAILIO_ADVERTISE_WSS_HOST=172.30.44.9",
        "CONVERACT_FABRIC_KAMAILIO_TRUSTED_SOURCE_CIDRS=172.30.44.0/24",
        "CONVERACT_FABRIC_KAMAILIO_RUSTPBX_SOURCE_CIDRS=172.30.44.10/32",
        "CONVERACT_FABRIC_KAMAILIO_DMQ_SOURCE_CIDRS=127.0.0.1/32",
        "CONVERACT_FABRIC_KAMAILIO_WEBPHONE_ALLOWED_ORIGINS=https://capacity.invalid",
        "CONVERACT_FABRIC_WEBPHONE_JWT_ISSUER=converact-capacity",
        "CONVERACT_FABRIC_WEBPHONE_JWT_AUDIENCE=rustpbx-capacity",
        "CONVERACT_FABRIC_KAMAILIO_ALLOW_PUBLIC_WSS=false",
        "CONVERACT_FABRIC_KAMAILIO_REQUIRE_CLIENT_CERTIFICATE=false",
        "CONVERACT_FABRIC_KAMAILIO_PER_SOURCE_INVITE_CPS=100000",
        "CONVERACT_FABRIC_KAMAILIO_CELL_INVITE_CPS=100000",
        "CONVERACT_FABRIC_KAMAILIO_PIKE_REQUEST_DENSITY=1000000",
        "CONVERACT_FABRIC_KAMAILIO_MAX_FAILOVERS=1",
        "RUSTPBX_OWNER_NODE_ID=rustpbx-a",
        "RUSTPBX_OWNER_NODE_ID_B=rustpbx-shadow",
    ]
    write_private(output / ".env", "\n".join(env_lines) + "\n")
    print(output)


if __name__ == "__main__":
    main()
