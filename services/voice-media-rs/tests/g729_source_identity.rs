use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

const CANDIDATE_PATH: &str = "../../docs/capacity/forks/rvoip-g729-source-candidate-v1.json";
const VENDOR_ROOT: &str = "vendor/rvoip-g729";

#[test]
fn imported_rvoip_g729_slice_matches_all_136_pinned_tuples() {
    let crate_root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidate_path = crate_root.join(CANDIDATE_PATH);
    let candidate_bytes = fs::read(&candidate_path).unwrap();
    let candidate: Value = serde_json::from_slice(&candidate_bytes).unwrap();

    let vendor_root = crate_root.join(VENDOR_ROOT);
    let snapshot: Value =
        serde_json::from_slice(&fs::read(vendor_root.join("SOURCE_FILES.json")).unwrap()).unwrap();
    assert_eq!(snapshot["source"], candidate["source"]);
    assert_eq!(
        snapshot["source_set_sha256"],
        candidate["source_set_sha256"]
    );
    assert_eq!(snapshot["selected_sources"], candidate["selected_sources"]);

    let selected = candidate["selected_sources"].as_array().unwrap();
    assert_eq!(selected.len(), 136);
    let mut expected_rust_files = BTreeSet::new();
    for entry in selected {
        let planned_target = entry["planned_target"].as_str().unwrap();
        let relative = planned_target
            .strip_prefix("services/voice-media-rs/vendor/rvoip-g729/")
            .unwrap();
        expected_rust_files.insert(relative.to_owned());
        assert_file_identity(
            &vendor_root.join(relative),
            entry["bytes"].as_u64().unwrap(),
            entry["sha256"].as_str().unwrap(),
        );
    }
    assert_eq!(
        expected_rust_files,
        imported_upstream_rust_files(&vendor_root)
    );

    let support = candidate["support_files"].as_array().unwrap();
    assert_eq!(support.len(), 3);
    for (upstream_path, local_path) in [
        ("LICENSE", "LICENSE"),
        ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
        ("crates/media/codec-core/Cargo.toml", "UPSTREAM_CARGO.toml"),
    ] {
        let entry = support
            .iter()
            .find(|entry| entry["path"].as_str() == Some(upstream_path))
            .unwrap();
        assert_file_identity(
            &vendor_root.join(local_path),
            entry["bytes"].as_u64().unwrap(),
            entry["sha256"].as_str().unwrap(),
        );
    }
}

fn assert_file_identity(path: &Path, bytes: u64, sha256: &str) {
    let metadata = fs::symlink_metadata(path).unwrap();
    assert!(
        metadata.file_type().is_file(),
        "not a file: {}",
        path.display()
    );
    assert!(
        !metadata.file_type().is_symlink(),
        "symlink: {}",
        path.display()
    );
    let body = fs::read(path).unwrap();
    assert_eq!(body.len() as u64, bytes, "size drift: {}", path.display());
    assert_eq!(
        format!("{:x}", Sha256::digest(&body)),
        sha256,
        "hash drift: {}",
        path.display()
    );
}

fn imported_upstream_rust_files(vendor_root: &Path) -> BTreeSet<String> {
    let mut files = BTreeSet::new();
    collect_rust_files(vendor_root, vendor_root.join("mod.rs"), &mut files);
    collect_tree(vendor_root, &vendor_root.join("impls"), &mut files);
    files
}

fn collect_tree(root: &Path, directory: &Path, files: &mut BTreeSet<String>) {
    let metadata = fs::symlink_metadata(directory).unwrap();
    assert!(metadata.file_type().is_dir());
    assert!(!metadata.file_type().is_symlink());
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let metadata = fs::symlink_metadata(&path).unwrap();
        assert!(
            !metadata.file_type().is_symlink(),
            "symlink: {}",
            path.display()
        );
        if metadata.file_type().is_dir() {
            collect_tree(root, &path, files);
        } else if path.extension().and_then(|value| value.to_str()) == Some("rs") {
            collect_rust_files(root, path, files);
        }
    }
}

fn collect_rust_files(root: &Path, path: impl Into<PathBuf>, files: &mut BTreeSet<String>) {
    let path = path.into();
    let relative = path.strip_prefix(root).unwrap().to_string_lossy();
    assert!(files.insert(relative.into_owned()), "duplicate source path");
}
