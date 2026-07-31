package egresspool

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPolicyAllowsEverythingWhenUnconfigured(t *testing.T) {
	policy, err := NewPolicy("", "")
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Allows("track") || !policy.Allows("room_composite") {
		t.Fatal("unconfigured policy must preserve upstream behavior")
	}
}

func TestPolicyHardFencesRequestTypes(t *testing.T) {
	policy, err := NewPolicy("track", "track")
	if err != nil {
		t.Fatal(err)
	}
	if !policy.Allows("track") {
		t.Fatal("track pool must accept track requests")
	}
	if policy.Allows("room_composite") || policy.Allows("track_composite") {
		t.Fatal("track pool must reject composite requests")
	}
}

func TestPolicyRejectsUnsafeConfiguration(t *testing.T) {
	for _, input := range []struct {
		pool, allowed string
	}{
		{"", "track"},
		{"track", "track,unknown"},
		{"track", ","},
	} {
		if _, err := NewPolicy(input.pool, input.allowed); err == nil {
			t.Fatalf("expected configuration error for %#v", input)
		}
	}
}

func TestPolicyEnforcesExplicitWorkerSlots(t *testing.T) {
	policy, err := NewPolicyWithCapacity("track", "track", "2", "")
	if err != nil {
		t.Fatal(err)
	}
	if !policy.AllowsConcurrent(0) || !policy.AllowsConcurrent(1) {
		t.Fatal("worker must accept below its slot limit")
	}
	if policy.AllowsConcurrent(2) || policy.AllowsConcurrent(3) {
		t.Fatal("worker must reject at and above its slot limit")
	}
	if _, err = NewPolicyWithCapacity("track", "track", "0", ""); err == nil {
		t.Fatal("zero is not a valid configured slot limit")
	}
}

func TestPolicyDrainsFromAnAtomicFileBoundary(t *testing.T) {
	drainFile := filepath.Join(t.TempDir(), "draining")
	policy, err := NewPolicyWithCapacity("track", "track", "2", drainFile)
	if err != nil {
		t.Fatal(err)
	}
	if policy.Draining() {
		t.Fatal("missing drain file must accept traffic")
	}
	if err = os.WriteFile(drainFile, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if !policy.Draining() {
		t.Fatal("present drain file must reject new work")
	}
	if _, err = NewPolicyWithCapacity("track", "track", "2", "relative/drain"); err == nil {
		t.Fatal("drain file must be absolute")
	}
}

func TestPolicyExportsBoundedCapacityAndRejectionEvidence(t *testing.T) {
	spool := filepath.Join(t.TempDir(), "spool")
	policy, err := NewPolicyWithMetrics("track", "track", "64", "", spool)
	if err != nil {
		t.Fatal(err)
	}
	if policy.MaxConcurrent() != 64 || policy.SpoolPath() != spool {
		t.Fatal("policy metrics identity mismatch")
	}
	policy.ObserveRejection("slots")
	policy.ObserveRejection("slots")
	policy.ObserveRejection("request_type")
	if policy.Rejections("slots") != 2 || policy.Rejections("request_type") != 1 {
		t.Fatal("policy rejection counters mismatch")
	}
	if _, err = NewPolicyWithMetrics("track", "track", "64", "", "relative/spool"); err == nil {
		t.Fatal("spool path must be absolute")
	}
}
