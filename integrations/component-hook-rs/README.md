# Converact Fabric Rust Component Hook

This crate is the source-level hook for RustDesk Server and RustPBX forks. It
has no third-party dependencies and accepts an injected `Authorizer` transport.

## Integration

1. Use the process's existing asynchronous HTTP stack to obtain an
   `Authorization`, then call `open_authorized`, `refresh_authorized`, or
   `close_authorized`. Synchronous hosts may implement `Authorizer` directly.
2. Create one `Guard` for each relay/control session or SIP call owner.
3. Call `open` before installing ownership.
4. Refresh in a background task before the cached node lease expires.
5. Call `assert_mutation` for control, clipboard, file, recording, transfer, or
   call-control commands.
6. Call `close` during owner teardown.
7. Use `snapshot` only to verify the authorized component/node identity or
   expose bounded diagnostics; it does not perform transport work.

`assert_mutation` only reads the in-process cache. Do not invoke the injected
transport from RustDesk frame relay, RTP packet, codec, encryption, or file-copy
loops.
