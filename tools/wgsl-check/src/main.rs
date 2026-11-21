//! Validate every .wgsl file in the repository using naga.
//!
//! Parses and validates with WebGPU-core capabilities (no optional features),
//! so anything that passes here is loadable on a spec-conformant device.
//! Run from repo root: `cargo run --quiet --manifest-path tools/wgsl-check/Cargo.toml`
//! (or `npm run check:shaders`). Exits non-zero if any shader fails.

use std::fs;
use std::path::{Path, PathBuf};

fn skip_dir(name: &str) -> bool {
    matches!(name, "node_modules" | ".git" | "target" | "dist")
}

fn collect_wgsl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !skip_dir(entry.file_name().to_string_lossy().as_ref()) {
                collect_wgsl(&path, out);
            }
        } else if path.extension().and_then(|e| e.to_str()) == Some("wgsl") {
            out.push(path);
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::current_dir()?;
    let mut shaders = Vec::new();
    collect_wgsl(&root, &mut shaders);
    shaders.sort();

    if shaders.is_empty() {
        eprintln!("no .wgsl files found under {}", root.display());
        std::process::exit(1);
    }

    let mut failed = false;
    for path in &shaders {
        let source = fs::read_to_string(path)?;
        let module = match naga::front::wgsl::parse_str(&source) {
            Ok(module) => module,
            Err(err) => {
                eprintln!("FAIL parse    {}: {}", path.display(), err);
                failed = true;
                continue;
            }
        };
        let mut validator = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::empty(),
        );
        match validator.validate(&module) {
            Ok(_) => println!("OK   {}", path.strip_prefix(&root)?.display()),
            Err(err) => {
                eprintln!("FAIL validate {}: {}", path.display(), err);
                failed = true;
            }
        }
    }

    if failed {
        std::process::exit(1);
    }
    println!("{} shaders valid", shaders.len());
    Ok(())
}
