"""Fail-closed compatibility boundary for Converact environment variables."""

from __future__ import annotations

import json
import re
import warnings
from collections.abc import Callable, Mapping, MutableMapping

Environment = Mapping[str, str | None]
MutableEnvironment = MutableMapping[str, str | None]
DeprecationEvent = dict[str, str]
DeprecationHandler = Callable[[DeprecationEvent], None]

_ENV_SUFFIX = re.compile(r"^[A-Z][A-Z0-9_]*$")


def _keys(scope: str, suffix: str) -> tuple[str, str]:
    if not _ENV_SUFFIX.fullmatch(suffix):
        raise ValueError(f"invalid branded environment variable suffix: {suffix}")
    if scope == "fabric":
        return f"CONVERACT_FABRIC_{suffix}", f"OPC_IVEKIT_{suffix}"
    return f"CONVERACT_{suffix}", f"OPC_{suffix}"


def _default_deprecation_handler(event: DeprecationEvent) -> None:
    warnings.warn(
        json.dumps(event, separators=(",", ":"), sort_keys=True),
        DeprecationWarning,
        stacklevel=3,
    )


def _resolve(
    env: Environment,
    scope: str,
    suffix: str,
    on_deprecation: DeprecationHandler | None,
) -> str | None:
    current_key, legacy_key = _keys(scope, suffix)
    has_current = current_key in env
    has_legacy = legacy_key in env

    if has_current and has_legacy and env[current_key] != env[legacy_key]:
        raise ValueError(
            "conflicting branded environment variables: "
            f"{current_key} and {legacy_key}"
        )
    if has_current:
        return env[current_key]
    if not has_legacy:
        return None

    (on_deprecation or _default_deprecation_handler)(
        {
            "event": "converact.config.deprecated_environment_key",
            "scope": scope,
            "current_key": current_key,
            "legacy_key": legacy_key,
        }
    )
    return env[legacy_key]


def resolve_brand_env(
    env: Environment,
    suffix: str,
    *,
    on_deprecation: DeprecationHandler | None = None,
) -> str | None:
    return _resolve(env, "brand", suffix, on_deprecation)


def resolve_fabric_env(
    env: Environment,
    suffix: str,
    *,
    on_deprecation: DeprecationHandler | None = None,
) -> str | None:
    return _resolve(env, "fabric", suffix, on_deprecation)


def resolve_converact_env(
    env: Environment,
    key: str,
    *,
    on_deprecation: DeprecationHandler | None = None,
) -> str | None:
    if key.startswith("CONVERACT_FABRIC_"):
        return resolve_fabric_env(
            env,
            key.removeprefix("CONVERACT_FABRIC_"),
            on_deprecation=on_deprecation,
        )
    if key.startswith("OPC_IVEKIT_"):
        return resolve_fabric_env(
            env,
            key.removeprefix("OPC_IVEKIT_"),
            on_deprecation=on_deprecation,
        )
    if key.startswith("CONVERACT_"):
        return resolve_brand_env(
            env,
            key.removeprefix("CONVERACT_"),
            on_deprecation=on_deprecation,
        )
    if key.startswith("OPC_"):
        return resolve_brand_env(
            env,
            key.removeprefix("OPC_"),
            on_deprecation=on_deprecation,
        )
    return env[key] if key in env else None


def install_brand_env_aliases(
    env: MutableEnvironment,
    *,
    on_deprecation: DeprecationHandler | None = None,
) -> dict[str, list[str]]:
    aliases: dict[str, tuple[str, str]] = {}
    for key in env:
        if key.startswith("CONVERACT_FABRIC_"):
            aliases[key] = ("fabric", key.removeprefix("CONVERACT_FABRIC_"))
        elif key.startswith("OPC_IVEKIT_"):
            suffix = key.removeprefix("OPC_IVEKIT_")
            aliases[f"CONVERACT_FABRIC_{suffix}"] = ("fabric", suffix)
        elif key.startswith("CONVERACT_"):
            aliases[key] = ("brand", key.removeprefix("CONVERACT_"))
        elif key.startswith("OPC_"):
            suffix = key.removeprefix("OPC_")
            aliases[f"CONVERACT_{suffix}"] = ("brand", suffix)

    pending: list[tuple[str, str | None]] = []
    deprecations: list[DeprecationEvent] = []
    for current_key in sorted(aliases):
        scope, suffix = aliases[current_key]
        had_current = current_key in env
        value = _resolve(env, scope, suffix, deprecations.append)
        if not had_current:
            pending.append((current_key, value))

    for current_key, value in pending:
        env[current_key] = value
    emit = on_deprecation or _default_deprecation_handler
    for event in deprecations:
        emit(event)

    return {"installed": [current_key for current_key, _ in pending]}
