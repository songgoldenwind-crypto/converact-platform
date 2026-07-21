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
    if name == "RUSTPBX_IMAGE" and not (
        re.search(r"@sha256:[a-f0-9]{64}$", value)
        or re.search(r":\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$", value)
    ):
        raise SystemExit("RUSTPBX_IMAGE must use an immutable digest or exact version tag")
    return value


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
        "POSTGRES_IMAGE": required_image("POSTGRES_IMAGE", True),
        "PYTHON_IMAGE": required_image("PYTHON_IMAGE", True),
    }
    runtime = {
        "RUSTPBX_DB_PASSWORD": secrets.token_hex(32),
        "RUSTPBX_MANAGEMENT_TOKEN": secrets.token_urlsafe(36),
        "RUSTPBX_RWI_TOKEN": secrets.token_urlsafe(36),
        "RUSTPBX_WEBHOOK_TOKEN": secrets.token_urlsafe(36),
        "RUSTPBX_TRUNK_CREDENTIAL": secrets.token_urlsafe(36),
    }
    template = (ROOT / "rustpbx.toml.template").read_text(encoding="utf-8")
    config = PLACEHOLDER.sub(lambda match: runtime[match.group(1)], template)
    if PLACEHOLDER.search(config):
        raise SystemExit("RustPBX config contains an unresolved placeholder")

    config_path = output / "rustpbx.toml"
    write_private(config_path, config)
    env_lines = [
        "COMPOSE_PROJECT_NAME=ivekit-rustpbx-baseline",
        *(f"{name}={value}" for name, value in images.items()),
        *(f"{name}={value}" for name, value in runtime.items()),
        f"RUSTPBX_CONFIG_FILE={config_path}",
    ]
    write_private(output / ".env", "\n".join(env_lines) + "\n")
    print(output)


if __name__ == "__main__":
    main()

