package egresspool

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
)

const (
	PoolNameEnv            = "IVEKIT_EGRESS_POOL_NAME"
	AllowedRequestTypesEnv = "IVEKIT_EGRESS_ALLOWED_REQUEST_TYPES"
	MaxConcurrentEnv       = "IVEKIT_EGRESS_MAX_CONCURRENT_REQUESTS"
	DrainFileEnv           = "IVEKIT_EGRESS_DRAIN_FILE"
	SpoolPathEnv           = "IVEKIT_EGRESS_SPOOL_PATH"
)

var knownRequestTypes = map[string]struct{}{
	"media":           {},
	"participant":     {},
	"room_composite":  {},
	"template":        {},
	"track":           {},
	"track_composite": {},
	"web":             {},
}

type Policy struct {
	poolName              string
	allowed               map[string]struct{}
	maxConcurrent         int32
	drainFile             string
	spoolPath             string
	drainingRejections    atomic.Uint64
	requestTypeRejections atomic.Uint64
	slotRejections        atomic.Uint64
}

func PolicyFromEnv() (*Policy, error) {
	return NewPolicyWithMetrics(
		os.Getenv(PoolNameEnv),
		os.Getenv(AllowedRequestTypesEnv),
		os.Getenv(MaxConcurrentEnv),
		os.Getenv(DrainFileEnv),
		os.Getenv(SpoolPathEnv),
	)
}

func NewPolicy(poolName, allowedCSV string) (*Policy, error) {
	return NewPolicyWithCapacity(poolName, allowedCSV, "", "")
}

func NewPolicyWithCapacity(poolName, allowedCSV, maxConcurrent, drainFile string) (*Policy, error) {
	return NewPolicyWithMetrics(poolName, allowedCSV, maxConcurrent, drainFile, "")
}

func NewPolicyWithMetrics(poolName, allowedCSV, maxConcurrent, drainFile, spoolPath string) (*Policy, error) {
	poolName = strings.TrimSpace(poolName)
	allowedCSV = strings.TrimSpace(allowedCSV)
	maxConcurrent = strings.TrimSpace(maxConcurrent)
	drainFile = strings.TrimSpace(drainFile)
	spoolPath = strings.TrimSpace(spoolPath)
	policy := &Policy{
		poolName:  poolName,
		allowed:   make(map[string]struct{}),
		drainFile: drainFile,
		spoolPath: spoolPath,
	}
	if (allowedCSV != "" || maxConcurrent != "" || drainFile != "" || spoolPath != "") && poolName == "" {
		return nil, fmt.Errorf("%s is required when %s is configured", PoolNameEnv, AllowedRequestTypesEnv)
	}
	if allowedCSV != "" {
		for _, value := range strings.Split(allowedCSV, ",") {
			requestType := strings.TrimSpace(value)
			if _, ok := knownRequestTypes[requestType]; !ok {
				return nil, fmt.Errorf("unsupported iveKit Egress request type %q", requestType)
			}
			policy.allowed[requestType] = struct{}{}
		}
		if len(policy.allowed) == 0 {
			return nil, fmt.Errorf("%s must include at least one request type", AllowedRequestTypesEnv)
		}
	}
	if maxConcurrent != "" {
		value, err := strconv.ParseInt(maxConcurrent, 10, 32)
		if err != nil || value < 1 {
			return nil, fmt.Errorf("%s must be an integer between 1 and 2147483647", MaxConcurrentEnv)
		}
		policy.maxConcurrent = int32(value)
	}
	if drainFile != "" && !filepath.IsAbs(drainFile) {
		return nil, fmt.Errorf("%s must be an absolute path", DrainFileEnv)
	}
	if spoolPath != "" && !filepath.IsAbs(spoolPath) {
		return nil, fmt.Errorf("%s must be an absolute path", SpoolPathEnv)
	}
	return policy, nil
}

func (p *Policy) MaxConcurrent() int32 {
	if p == nil {
		return 0
	}
	return p.maxConcurrent
}

func (p *Policy) SpoolPath() string {
	if p == nil {
		return ""
	}
	return p.spoolPath
}

func (p *Policy) ObserveRejection(reason string) {
	if p == nil {
		return
	}
	switch reason {
	case "draining":
		p.drainingRejections.Add(1)
	case "request_type":
		p.requestTypeRejections.Add(1)
	case "slots":
		p.slotRejections.Add(1)
	}
}

func (p *Policy) Rejections(reason string) uint64 {
	if p == nil {
		return 0
	}
	switch reason {
	case "draining":
		return p.drainingRejections.Load()
	case "request_type":
		return p.requestTypeRejections.Load()
	case "slots":
		return p.slotRejections.Load()
	default:
		return 0
	}
}

func (p *Policy) Allows(requestType string) bool {
	if p == nil || len(p.allowed) == 0 {
		return true
	}
	_, ok := p.allowed[requestType]
	return ok
}

func (p *Policy) PoolName() string {
	if p == nil {
		return ""
	}
	return p.poolName
}

func (p *Policy) AllowsConcurrent(active int32) bool {
	return p == nil || p.maxConcurrent == 0 || active < p.maxConcurrent
}

func (p *Policy) Draining() bool {
	if p == nil || p.drainFile == "" {
		return false
	}
	_, err := os.Stat(p.drainFile)
	return err == nil || !os.IsNotExist(err)
}
