use std::fs;
use std::path::Path;

const OFFICIAL_VECTOR_MANIFEST: &str =
    "vendor/rvoip-g729/testdata/itu-g729-vectors-v1/manifest.json";

#[test]
#[ignore = "reference_vectors remains not_run until a rights-reviewed official ITU bundle is injected"]
fn official_g729a_and_g729ab_reference_vectors_match() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(OFFICIAL_VECTOR_MANIFEST);
    let manifest = fs::read(&path).unwrap_or_else(|error| {
        panic!(
            "RED: official G.729 vector manifest is unavailable at {}: {error}",
            path.display()
        )
    });
    assert!(
        !manifest.is_empty(),
        "RED: official G.729 vector manifest is empty"
    );
    panic!(
        "RED: vector bundle exists, but exact artifact hashes and expected outputs remain unreviewed"
    );
}
