# Converact Fabric Tinode v0.25.3 Topic Owner Hook

This module binds a Converact Fabric-managed Tinode group topic to one Cell reservation.
It preserves the native Tinode wire protocol and cluster ring.

- ROOT topic creation stores `interaction_id`, `reservation_id`,
  `owner_node_id`, and `owner_epoch` under `desc.trusted.ivekit_placement`.
- The topic master opens the owner before the actor starts.
- Existing topics restore the same owner from persisted Trusted metadata.
- A secured prepare endpoint can preload a newer owner before a failed topic is
  rebuilt on another node.
- Publish, edit, delete, and metadata mutations read only the in-process guard.
- Refresh is bounded to batches of 64 topics.
- Tinode message fanout, serialization, and persistence loops never call HTTP.

The stable Tinode `cluster_self`, component-node sidecar ID, and placement
`owner_node_id` must be identical.

The hook is disabled when no `CONVERACT_FABRIC_COMPONENT_NODE_*` settings are present.
Production Cell deployments set:

```text
CONVERACT_FABRIC_COMPONENT_NODE_ENDPOINT=http://127.0.0.1:3210
CONVERACT_FABRIC_COMPONENT_NODE_TOKEN=<secret>
CONVERACT_FABRIC_COMPONENT_NODE_ID=<stable-statefulset-pod-name>
CONVERACT_FABRIC_OWNER_GUARD_REQUIRED=1
CONVERACT_FABRIC_OWNER_REFRESH_INTERVAL_MS=3000
CONVERACT_FABRIC_OWNER_REFRESH_TIMEOUT_MS=1000
CONVERACT_FABRIC_TINODE_OWNER_API_TOKEN=<separate-secret>
```

Local module tests do not replace applying the overlay to the exact upstream
commit, compiling it with Go 1.26, or running a real multi-node Tinode cluster.
