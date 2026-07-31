# iveKit RustDesk 1.4.9 Native Control and Evidence Overlay

This overlay adds the fixed `ivekit-rustdesk-native-control-v2` Windows named-pipe endpoint to the RustDesk Connection Manager and the `rustdesk-native-evidence-v1` allowlist scanner. The control request carries the exact interaction, reservation, owner epoch, command ID, and native connection ID. The overlay echoes the owner identity, calls RustDesk's existing `ui_cm_interface::close(id)`, and waits until only the selected native connection ID disappears. The evidence path baselines ACL-configured roots and emits metadata-only candidates for stable new files while an authorized controller is active. Neither path accepts executable paths or shell commands.

Apply it only to upstream tag `1.4.9` at exact commit
`6c578292e8ebbbec708b76986ba8c4bc7c509747`:

```sh
node integrations/rustdesk-1.4.9/apply-overlay.mjs /path/to/rustdesk-1.4.9
```

The patcher verifies the Git `HEAD` before touching files and fails closed if
the commit or the upstream `src/lib.rs`/`src/ui_cm_interface.rs` anchors drift.
Build the Windows x86_64 client with the normal RustDesk build process, sign it,
publish it to the controlled artifact repository, and record
`native_control_protocol: ivekit-rustdesk-native-control-v2` beside its SHA-256
in the iveKit Windows client profile. Placement-enabled package version 6
rejects installers without v2. The companion still understands v1 only for a
rolling deployment in which Cell placement is explicitly disabled.

The companion's ACL-protected registry remains authoritative for the `external_id + target_id + rustdesk_id -> native_session_id` binding. Before native execution it verifies the server owner binding and persists the greatest accepted epoch in one atomic state shard per exact external session. Stale commands fail closed, equal command IDs replay idempotently, and a dead-process lock is recovered without rewriting a global session document. Evidence candidates are not upload authorizations: the companion must correlate each candidate with the current device-token owner context before copying or uploading bytes.

`.github/workflows/ivekit-rustdesk-windows-ci.yml` checks out the pinned upstream source with submodules, applies this overlay, installs the upstream vcpkg manifest, and runs a Windows `cargo check`. A signed release binary and two-machine behavior remain real-environment acceptance items.
