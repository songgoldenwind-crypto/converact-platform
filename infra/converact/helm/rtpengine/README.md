# Converact Fabric RTPengine media node

This chart deploys one RTPengine and media-control pair per labelled media
node. RTPengine keeps forwarding media if the media-control container restarts;
media-control recovers command state from its node-local WAL.

## Required node preparation

1. Label and taint only dedicated media nodes using the selectors and
   tolerations in the selected values profile.
2. Create `mediaControl.wal.hostPath` on every selected node with owner
   `1000:1000` and mode `0700`. The chart uses `hostPath.type=Directory` so a
   missing or incorrectly provisioned durable path fails closed.
3. Allow only the configured UDP media range through the node firewall.
   Keep TCP 22222 private; the chart binds NG control to node loopback.
   Restrict TCP 8080 and 3211 to cluster monitoring and control traffic.
4. The default uses the Pod's node `hostIP` as the RTPengine interface. For
   NAT or a dedicated media address, disable `interfaceFromHostIP` and set
   `rtpengine.interface` explicitly in a node-homogeneous release.
5. Supply immutable `sha256:` digests for both images and create:
   - `mediaControl.existingSecret` with `service-token` and `admission-token`.
   - `mediaControl.tlsSecret` with `tls.key`, `tls.crt`, and `ca.crt`.

Userspace nodes use `values-userspace.yaml`. Kernel nodes must use
`values-kernel.yaml`, carry the exact readiness label, and have the matching
`nft_rtpengine` module already loaded. The chart never loads host modules.

Before a pod terminates, media-control sends `converact drain`; RTPengine waits
inside its pre-stop hook so existing sessions can finish while placement stops
new admissions.

The Service is headless. Placement must call the selected media node's
node-specific media-control endpoint; it must not treat Service DNS as a
randomly load-balanced command endpoint.
