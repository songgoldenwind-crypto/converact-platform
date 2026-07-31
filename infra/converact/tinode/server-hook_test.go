package main

import "testing"

func TestIvekitTinodeStandaloneKeepsClusterDisabled(t *testing.T) {
	t.Setenv("IVEKIT_COMPONENT_NODE_ID", "tinode-node-a")
	t.Setenv("IVEKIT_TINODE_CLUSTER_MODE", "standalone")
	clusterSelf := ""

	if err := ivekitUseStableClusterNodeID(&clusterSelf); err != nil {
		t.Fatalf("standalone cluster identity: %v", err)
	}
	if clusterSelf != "" {
		t.Fatalf("standalone cluster_self = %q, want empty", clusterSelf)
	}
}

func TestIvekitTinodeClusteredUsesComponentNodeID(t *testing.T) {
	t.Setenv("IVEKIT_COMPONENT_NODE_ID", "ivekit-tinode-cell-0")
	t.Setenv("IVEKIT_TINODE_CLUSTER_MODE", "clustered")
	clusterSelf := ""

	if err := ivekitUseStableClusterNodeID(&clusterSelf); err != nil {
		t.Fatalf("clustered cluster identity: %v", err)
	}
	if clusterSelf != "ivekit-tinode-cell-0" {
		t.Fatalf("clustered cluster_self = %q", clusterSelf)
	}
}

func TestIvekitTinodeStandaloneRejectsConfiguredClusterSelf(t *testing.T) {
	t.Setenv("IVEKIT_COMPONENT_NODE_ID", "tinode-node-a")
	t.Setenv("IVEKIT_TINODE_CLUSTER_MODE", "standalone")
	clusterSelf := "tinode-node-a"

	if err := ivekitUseStableClusterNodeID(&clusterSelf); err == nil {
		t.Fatal("standalone mode accepted a configured cluster_self")
	}
}

func TestIvekitTinodeClusteredRequiresComponentNodeID(t *testing.T) {
	t.Setenv("IVEKIT_COMPONENT_NODE_ID", "")
	t.Setenv("IVEKIT_TINODE_CLUSTER_MODE", "clustered")
	clusterSelf := ""

	if err := ivekitUseStableClusterNodeID(&clusterSelf); err == nil {
		t.Fatal("clustered mode accepted an empty component node ID")
	}
}

func TestIvekitTinodeRejectsUnknownClusterMode(t *testing.T) {
	t.Setenv("IVEKIT_COMPONENT_NODE_ID", "tinode-node-a")
	t.Setenv("IVEKIT_TINODE_CLUSTER_MODE", "unexpected")
	clusterSelf := ""

	if err := ivekitUseStableClusterNodeID(&clusterSelf); err == nil {
		t.Fatal("unknown cluster mode was accepted")
	}
}
