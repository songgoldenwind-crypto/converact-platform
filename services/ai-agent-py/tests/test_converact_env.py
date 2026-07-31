from __future__ import annotations

import unittest

from converact_env import (
    install_brand_env_aliases,
    resolve_brand_env,
    resolve_converact_env,
    resolve_fabric_env,
)


class ConveractEnvironmentTest(unittest.TestCase):
    def test_resolves_current_legacy_and_equal_values(self) -> None:
        self.assertEqual(resolve_brand_env({"CONVERACT_API_KEY": "new"}, "API_KEY"), "new")
        self.assertEqual(resolve_brand_env({"OPC_API_KEY": "old"}, "API_KEY"), "old")
        self.assertEqual(
            resolve_brand_env(
                {"CONVERACT_API_KEY": "same", "OPC_API_KEY": "same"},
                "API_KEY",
            ),
            "same",
        )

    def test_emits_a_redacted_event_only_for_legacy_only_values(self) -> None:
        events: list[dict[str, str]] = []
        secret = "must-never-be-logged"
        self.assertEqual(
            resolve_brand_env(
                {"OPC_API_KEY": secret},
                "API_KEY",
                on_deprecation=events.append,
            ),
            secret,
        )
        self.assertEqual(
            events,
            [
                {
                    "event": "converact.config.deprecated_environment_key",
                    "scope": "brand",
                    "current_key": "CONVERACT_API_KEY",
                    "legacy_key": "OPC_API_KEY",
                }
            ],
        )
        self.assertNotIn(secret, repr(events))

        events.clear()
        resolve_brand_env(
            {"CONVERACT_API_KEY": secret, "OPC_API_KEY": secret},
            "API_KEY",
            on_deprecation=events.append,
        )
        self.assertEqual(events, [])

    def test_rejects_conflicts_without_exposing_values(self) -> None:
        current_secret = "current-secret-value"
        legacy_secret = "legacy-secret-value"
        with self.assertRaisesRegex(ValueError, "conflicting branded environment variables") as raised:
            resolve_brand_env(
                {
                    "CONVERACT_API_KEY": current_secret,
                    "OPC_API_KEY": legacy_secret,
                },
                "API_KEY",
            )
        self.assertIn("CONVERACT_API_KEY", str(raised.exception))
        self.assertIn("OPC_API_KEY", str(raised.exception))
        self.assertNotIn(current_secret, str(raised.exception))
        self.assertNotIn(legacy_secret, str(raised.exception))

    def test_empty_strings_are_explicit(self) -> None:
        self.assertEqual(resolve_brand_env({"CONVERACT_API_KEY": ""}, "API_KEY"), "")
        with self.assertRaisesRegex(ValueError, "conflicting branded environment variables"):
            resolve_brand_env(
                {"CONVERACT_API_KEY": "", "OPC_API_KEY": "legacy"},
                "API_KEY",
            )

    def test_maps_the_fabric_namespace(self) -> None:
        events: list[dict[str, str]] = []
        self.assertEqual(
            resolve_fabric_env(
                {"OPC_IVEKIT_INSTANCE_ID": "legacy-instance"},
                "INSTANCE_ID",
                on_deprecation=events.append,
            ),
            "legacy-instance",
        )
        self.assertEqual(events[0]["current_key"], "CONVERACT_FABRIC_INSTANCE_ID")
        self.assertEqual(events[0]["legacy_key"], "OPC_IVEKIT_INSTANCE_ID")

    def test_resolves_full_current_keys_and_non_branded_keys(self) -> None:
        self.assertEqual(
            resolve_converact_env({"OPC_API_KEY": "legacy"}, "CONVERACT_API_KEY"),
            "legacy",
        )
        self.assertEqual(
            resolve_converact_env(
                {"OPC_IVEKIT_INSTANCE_ID": "legacy-instance"},
                "CONVERACT_FABRIC_INSTANCE_ID",
            ),
            "legacy-instance",
        )
        self.assertEqual(resolve_converact_env({"DATABASE_URL": ""}, "DATABASE_URL"), "")

    def test_installs_aliases_atomically(self) -> None:
        env = {
            "OPC_API_KEY": "brand-key",
            "OPC_IVEKIT_INSTANCE_ID": "fabric-instance",
        }
        events: list[dict[str, str]] = []
        result = install_brand_env_aliases(env, on_deprecation=events.append)
        self.assertEqual(
            result,
            {"installed": ["CONVERACT_API_KEY", "CONVERACT_FABRIC_INSTANCE_ID"]},
        )
        self.assertEqual(env["CONVERACT_API_KEY"], "brand-key")
        self.assertEqual(env["CONVERACT_FABRIC_INSTANCE_ID"], "fabric-instance")
        self.assertEqual(len(events), 2)

        conflicting = {
            "OPC_API_KEY": "legacy",
            "OPC_IVEKIT_INSTANCE_ID": "legacy-instance",
            "CONVERACT_FABRIC_INSTANCE_ID": "different-instance",
        }
        with self.assertRaisesRegex(ValueError, "conflicting branded environment variables"):
            install_brand_env_aliases(conflicting)
        self.assertNotIn("CONVERACT_API_KEY", conflicting)


if __name__ == "__main__":
    unittest.main()
