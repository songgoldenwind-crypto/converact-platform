package stats

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"

	"github.com/prometheus/client_golang/prometheus"
)

var iveKitPrometheusOnce sync.Once

func (m *Monitor) initIveKitPrometheus() {
	iveKitPrometheusOnce.Do(func() {
		labels := prometheus.Labels{
			"node_id": m.nodeID,
			"pool":    m.ivekitPool.PoolName(),
		}
		prometheus.MustRegister(prometheus.NewGaugeFunc(
			prometheus.GaugeOpts{
				Name:        "ivekit_livekit_egress_active_requests",
				Help:        "LiveKit Egress requests currently owned by this worker.",
				ConstLabels: labels,
			},
			func() float64 { return float64(m.requests.Load()) },
		))
		prometheus.MustRegister(prometheus.NewGaugeFunc(
			prometheus.GaugeOpts{
				Name:        "ivekit_livekit_egress_max_concurrent_requests",
				Help:        "Hard concurrent request limit configured for this worker.",
				ConstLabels: labels,
			},
			func() float64 { return float64(m.ivekitPool.MaxConcurrent()) },
		))
		prometheus.MustRegister(prometheus.NewGaugeFunc(
			prometheus.GaugeOpts{
				Name:        "ivekit_livekit_egress_draining",
				Help:        "Whether this Egress worker is rejecting new work for drain.",
				ConstLabels: labels,
			},
			func() float64 {
				if m.ivekitPool.Draining() {
					return 1
				}
				return 0
			},
		))
		for _, reason := range []string{"draining", "request_type", "slots"} {
			reason := reason
			prometheus.MustRegister(prometheus.NewCounterFunc(
				prometheus.CounterOpts{
					Name: "ivekit_livekit_egress_policy_rejections_total",
					Help: "LiveKit Egress requests rejected by the iveKit worker policy.",
					ConstLabels: prometheus.Labels{
						"node_id": m.nodeID,
						"pool":    m.ivekitPool.PoolName(),
						"reason":  reason,
					},
				},
				func() float64 { return float64(m.ivekitPool.Rejections(reason)) },
			))
		}
		prometheus.MustRegister(prometheus.NewGaugeFunc(
			prometheus.GaugeOpts{
				Name:        "ivekit_livekit_egress_spool_used_bytes",
				Help:        "Bytes used on the dedicated Egress backup spool filesystem.",
				ConstLabels: labels,
			},
			func() float64 {
				used, _ := iveKitSpoolBytes(m.ivekitPool.SpoolPath())
				return used
			},
		))
		prometheus.MustRegister(prometheus.NewGaugeFunc(
			prometheus.GaugeOpts{
				Name:        "ivekit_livekit_egress_spool_capacity_bytes",
				Help:        "Total bytes on the dedicated Egress backup spool filesystem.",
				ConstLabels: labels,
			},
			func() float64 {
				_, capacity := iveKitSpoolBytes(m.ivekitPool.SpoolPath())
				return capacity
			},
		))
		prometheus.MustRegister(prometheus.NewCounterFunc(
			prometheus.CounterOpts{
				Name:        "ivekit_livekit_egress_network_transmit_bytes_total",
				Help:        "Bytes transmitted by non-loopback interfaces in this Egress worker.",
				ConstLabels: labels,
			},
			iveKitNetworkTransmitBytes,
		))
	})
}

func iveKitSpoolBytes(path string) (float64, float64) {
	if path == "" || !filepath.IsAbs(path) {
		return 0, 0
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0
	}
	capacity := float64(stat.Blocks) * float64(stat.Bsize)
	available := float64(stat.Bavail) * float64(stat.Bsize)
	return capacity - available, capacity
}

func iveKitNetworkTransmitBytes() float64 {
	entries, err := os.ReadDir("/sys/class/net")
	if err != nil {
		return 0
	}
	var total uint64
	for _, entry := range entries {
		if entry.Name() == "lo" || strings.Contains(entry.Name(), "/") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("/sys/class/net", entry.Name(), "statistics/tx_bytes"))
		if err != nil {
			continue
		}
		value, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64)
		if err == nil {
			total += value
		}
	}
	return float64(total)
}
