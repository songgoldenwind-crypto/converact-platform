use std::collections::HashMap;
use std::hint::black_box;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Instant;

const FRAME_BYTES: usize = 64 * 1024;

struct UsageCounters {
    sequence: AtomicU64,
    elapsed: AtomicU64,
    total: AtomicU64,
    highest_speed: AtomicU64,
    current_speed: AtomicU64,
}

impl UsageCounters {
    fn new() -> Self {
        Self {
            sequence: AtomicU64::new(0),
            elapsed: AtomicU64::new(0),
            total: AtomicU64::new(0),
            highest_speed: AtomicU64::new(0),
            current_speed: AtomicU64::new(0),
        }
    }

    fn update(&self, elapsed: u64, total: u64, highest_speed: u64, current_speed: u64) {
        self.sequence.fetch_add(1, Ordering::AcqRel);
        self.elapsed.store(elapsed, Ordering::Relaxed);
        self.total.store(total, Ordering::Relaxed);
        self.highest_speed.store(highest_speed, Ordering::Relaxed);
        self.current_speed.store(current_speed, Ordering::Relaxed);
        self.sequence.fetch_add(1, Ordering::Release);
    }

    fn snapshot(&self) -> (u64, u64, u64, u64) {
        loop {
            let before = self.sequence.load(Ordering::Acquire);
            if before & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            let snapshot = (
                self.elapsed.load(Ordering::Relaxed),
                self.total.load(Ordering::Relaxed),
                self.highest_speed.load(Ordering::Relaxed),
                self.current_speed.load(Ordering::Relaxed),
            );
            if self.sequence.load(Ordering::Acquire) == before {
                return snapshot;
            }
        }
    }
}

fn measure(iterations: usize, mut operation: impl FnMut(usize)) -> f64 {
    let started = Instant::now();
    for iteration in 0..iterations {
        operation(black_box(iteration));
    }
    started.elapsed().as_nanos() as f64 / iterations as f64
}

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let usage_iterations = arguments
        .get(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(2_000_000);
    let frame_iterations = arguments
        .get(2)
        .and_then(|value| value.parse().ok())
        .unwrap_or(20_000);
    let id = String::from("relay-session-0001");
    let usage = RwLock::new(HashMap::from([(id.clone(), (0_u64, 0_u64, 0_u64, 0_u64))]));
    let baseline_usage = measure(usage_iterations, |iteration| {
        usage
            .write()
            .unwrap()
            .insert(id.clone(), (iteration as u64, iteration as u64, 4096, 2048));
    });
    black_box(usage.read().unwrap().len());

    let counters = UsageCounters::new();
    let owned_usage = measure(usage_iterations, |iteration| {
        counters.update(iteration as u64, iteration as u64, 4096, 2048);
    });
    black_box(counters.snapshot());

    let baseline_frame = measure(frame_iterations, |_| {
        let websocket_message = vec![0x5a_u8; FRAME_BYTES];
        let relay_frame = websocket_message[..].to_vec();
        let outbound_frame = relay_frame.to_vec();
        black_box(outbound_frame);
    });
    let owned_frame = measure(frame_iterations, |_| {
        let websocket_message = vec![0x5a_u8; FRAME_BYTES];
        let relay_frame = websocket_message;
        black_box(relay_frame);
    });

    println!(
        "scope=operation_only host={} frame_bytes={FRAME_BYTES}",
        std::env::consts::ARCH
    );
    println!("usage_global_map_lower_bound_ns_per_op={baseline_usage:.2}");
    println!("usage_atomic_sequence_ns_per_op={owned_usage:.2}");
    println!("frame_websocket_64k_copy_ns_per_op={baseline_frame:.2}");
    println!("frame_websocket_64k_owned_ns_per_op={owned_frame:.2}");
    println!("capacity_claim=none");
}
