use std::{
    io::{self, Write},
    sync::{Arc, Mutex},
};

use converact_kernel_ids::{CellId, TenantId};
use converact_observability::emit_runtime_initialized;
use converact_runtime_health::BuildIdentity;
use serde_json::Value;
use tracing_subscriber::fmt::MakeWriter;

#[test]
fn startup_telemetry_contains_exact_build_and_source_identity() {
    let output = MemoryWriter::default();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .without_time()
        .with_current_span(false)
        .with_span_list(false)
        .with_writer(output.clone())
        .finish();
    let identity =
        BuildIdentity::new("converact-api", "0.1.0", &"a".repeat(40)).expect("build identity");
    let tenant_id = TenantId::parse("tenant-a").expect("tenant identity");
    let cell_id = CellId::parse("cell-cn-north-1").expect("Cell identity");

    tracing::subscriber::with_default(subscriber, || {
        emit_runtime_initialized(&identity, &tenant_id, &cell_id);
    });

    let event: Value = serde_json::from_slice(&output.bytes()).expect("JSON telemetry event");
    let fields = event["fields"].as_object().expect("telemetry fields");
    assert_eq!(fields["service.name"], "converact-api");
    assert_eq!(fields["build.version"], "0.1.0");
    assert_eq!(fields["source.commit"], "a".repeat(40));
    assert_eq!(fields["tenant.id"], "tenant-a");
    assert_eq!(fields["cell.id"], "cell-cn-north-1");
}

#[derive(Clone, Default)]
struct MemoryWriter(Arc<Mutex<Vec<u8>>>);

impl MemoryWriter {
    fn bytes(&self) -> Vec<u8> {
        self.0.lock().expect("memory writer lock").clone()
    }
}

impl<'writer> MakeWriter<'writer> for MemoryWriter {
    type Writer = MemoryGuard;

    fn make_writer(&'writer self) -> Self::Writer {
        MemoryGuard(Arc::clone(&self.0))
    }
}

struct MemoryGuard(Arc<Mutex<Vec<u8>>>);

impl Write for MemoryGuard {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0
            .lock()
            .map_err(|_| io::Error::other("memory_writer_poisoned"))?
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
