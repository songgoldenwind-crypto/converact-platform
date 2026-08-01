# Converact Fabric Go Component Hook

This package is the source-level hook for LiveKit Server and Tinode Server forks.
It has no third-party dependencies.

## Integration

1. Create one `HTTPAuthorizer` for the local node-admission agent.
2. Create one `Guard` for each owned LiveKit room or Tinode topic.
3. Call `Open` before installing the room/topic owner.
4. Refresh the guard asynchronously before the cached node lease expires.
5. Call `AssertMutation` from command handling with the supplied owner epoch.
6. Call `Close` during owner teardown.

`AssertMutation` never performs HTTP or database work. Do not call `Open`,
`Refresh`, or `Close` from RTP packet routing, WebRTC forwarding, Tinode fanout,
serialization, or persistence batching loops.

The upstream fork remains responsible for storing the owner epoch in room/topic
state and carrying it on mutating internal commands.
