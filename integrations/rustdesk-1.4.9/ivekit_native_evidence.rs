use std::{
    collections::{hash_map::DefaultHasher, HashMap, HashSet},
    env,
    fs::{self, OpenOptions},
    hash::{Hash, Hasher},
    io::Write,
    path::{Path, PathBuf},
    sync::Once,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static START: Once = Once::new();
const SCAN_INTERVAL: Duration = Duration::from_secs(2);
const CONTROLLER_GRACE: Duration = Duration::from_secs(15 * 60);
const MAX_FILES: usize = 10_000;
const MAX_DEPTH: usize = 12;

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
enum RootClass {
    File,
    Recording,
}

#[derive(Clone)]
struct Root {
    class: RootClass,
    path: PathBuf,
}

#[derive(Clone)]
struct Snapshot {
    size: u64,
    modified_ms: u128,
    stable_scans: u8,
    emitted: bool,
}

pub fn start_once() {
    START.call_once(|| {
        let _ = thread::Builder::new()
            .name("ivekit-native-evidence".to_owned())
            .spawn(run);
    });
}

fn run() {
    let Some(program_data) = env::var_os("ProgramData") else {
        log::error!("iveKit native evidence is disabled: ProgramData is unavailable");
        return;
    };
    let current_install_root = PathBuf::from(&program_data).join("Converact").join("RustDesk");
    let legacy_install_root = PathBuf::from(program_data).join("iveKit").join("RustDesk");
    let current_roots_file = current_install_root
        .join("state")
        .join("native-evidence-roots-v1.txt");
    let legacy_roots_file = legacy_install_root
        .join("state")
        .join("native-evidence-roots-v1.txt");
    // New installations use the Converact directory. Existing installations
    // keep working until their signed roots file is migrated; never merge both
    // roots because that would create two evidence writers.
    let (install_root, roots_file) = if current_roots_file.is_file()
        || !legacy_roots_file.is_file()
    {
        (current_install_root, current_roots_file)
    } else {
        (legacy_install_root, legacy_roots_file)
    };
    let candidate_dir = install_root.join(r"native-evidence\candidates");
    let roots = match read_roots(&roots_file) {
        Ok(value) if !value.is_empty() => value,
        Ok(_) => {
            log::error!("iveKit native evidence is disabled: no allowlisted roots");
            return;
        }
        Err(error) => {
            log::error!("iveKit native evidence roots are unavailable: {error}");
            return;
        }
    };
    if let Err(error) = fs::create_dir_all(&candidate_dir) {
        log::error!("iveKit native evidence candidate directory is unavailable: {error}");
        return;
    }

    let mut snapshots: HashMap<(RootClass, PathBuf), Snapshot> = HashMap::new();
    let mut baseline = true;
    let mut last_controllers: Vec<String> = Vec::new();
    let mut last_controller_at = SystemTime::UNIX_EPOCH;
    loop {
        let current_controllers = crate::ui_cm_interface::ivekit_active_controller_ids();
        if !current_controllers.is_empty() {
            last_controllers = current_controllers;
            last_controller_at = SystemTime::now();
        } else if SystemTime::now()
            .duration_since(last_controller_at)
            .unwrap_or(CONTROLLER_GRACE + Duration::from_secs(1))
            > CONTROLLER_GRACE
        {
            last_controllers.clear();
        }

        let mut files = Vec::new();
        for root in &roots {
            collect_regular_files(root, &root.path, 0, &mut files);
            if files.len() >= MAX_FILES {
                break;
            }
        }
        let mut seen = HashSet::new();
        for (class, path, size, modified_ms) in files {
            let key = (class, path.clone());
            seen.insert(key.clone());
            let snapshot = snapshots.entry(key).or_insert_with(|| Snapshot {
                size,
                modified_ms,
                stable_scans: 0,
                emitted: baseline,
            });
            if snapshot.size != size || snapshot.modified_ms != modified_ms {
                snapshot.size = size;
                snapshot.modified_ms = modified_ms;
                snapshot.stable_scans = 0;
                snapshot.emitted = false;
                continue;
            }
            snapshot.stable_scans = snapshot.stable_scans.saturating_add(1);
            if snapshot.stable_scans < 2 || snapshot.emitted || last_controllers.is_empty() {
                continue;
            }
            match publish_candidate(
                &candidate_dir,
                class,
                &path,
                size,
                modified_ms,
                &last_controllers,
            ) {
                Ok(()) => snapshot.emitted = true,
                Err(error) => log::error!("iveKit native evidence candidate write failed: {error}"),
            }
        }
        snapshots.retain(|key, _| seen.contains(key));
        baseline = false;
        thread::sleep(SCAN_INTERVAL);
    }
}

fn read_roots(path: &Path) -> std::io::Result<Vec<Root>> {
    let contents = fs::read_to_string(path)?;
    let mut roots = Vec::new();
    let mut seen = HashSet::new();
    for line in contents.lines() {
        let Some((class, raw_path)) = line.split_once('\t') else {
            continue;
        };
        let class = match class {
            "file" => RootClass::File,
            "recording" => RootClass::Recording,
            _ => continue,
        };
        let path = PathBuf::from(raw_path);
        if !path.is_absolute() {
            continue;
        }
        let canonical = fs::canonicalize(path)?;
        if seen.insert((class, canonical.clone())) {
            roots.push(Root {
                class,
                path: canonical,
            });
        }
    }
    Ok(roots)
}

fn collect_regular_files(
    root: &Root,
    directory: &Path,
    depth: usize,
    output: &mut Vec<(RootClass, PathBuf, u64, u128)>,
) {
    if depth > MAX_DEPTH || output.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if output.len() >= MAX_FILES {
            return;
        }
        let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            collect_regular_files(root, &entry.path(), depth + 1, output);
            continue;
        }
        if !metadata.is_file() || metadata.len() == 0 {
            continue;
        }
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis())
            .unwrap_or(0);
        output.push((root.class, entry.path(), metadata.len(), modified_ms));
    }
}

fn publish_candidate(
    directory: &Path,
    class: RootClass,
    path: &Path,
    size: u64,
    modified_ms: u128,
    controllers: &[String],
) -> std::io::Result<()> {
    let observed_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut hasher = DefaultHasher::new();
    class.hash(&mut hasher);
    path.hash(&mut hasher);
    size.hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    controllers.hash(&mut hasher);
    let native_candidate_id = format!("native-candidate-{:016x}", hasher.finish());
    let destination = directory.join(format!("{native_candidate_id}.json"));
    if destination.exists() {
        return Ok(());
    }
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if filename.is_empty() {
        return Ok(());
    }
    let controller_rustdesk_ids = controllers
        .iter()
        .map(|value| format!("\"{}\"", json_escape(value)))
        .collect::<Vec<_>>()
        .join(",");
    let payload = format!(
        "{{\"schema_version\":1,\"native_candidate_id\":\"{}\",\"root_class\":\"{}\",\"source_path\":\"{}\",\"filename\":\"{}\",\"size_bytes\":{},\"observed_unix_ms\":{},\"controller_rustdesk_ids\":[{}]}}\n",
        native_candidate_id,
        match class { RootClass::File => "file", RootClass::Recording => "recording" },
        json_escape(&path.to_string_lossy()),
        json_escape(filename),
        size,
        observed_unix_ms,
        controller_rustdesk_ids,
    );
    let temporary = directory.join(format!(".{native_candidate_id}.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    file.write_all(payload.as_bytes())?;
    file.sync_all()?;
    drop(file);
    match fs::rename(&temporary, &destination) {
        Ok(()) => Ok(()),
        Err(_error) if destination.exists() => {
            let _ = fs::remove_file(temporary);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(temporary);
            Err(error)
        }
    }
}

fn json_escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value if value.is_control() => output.push_str(&format!("\\u{:04x}", value as u32)),
            value => output.push(value),
        }
    }
    output
}
