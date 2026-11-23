//! Validate every .wgsl file in the repository using naga.
//!
//! Parses and validates with WebGPU-core capabilities (no optional features),
//! so anything that passes here is loadable on a spec-conformant device.
//! Run from repo root: `cargo run --quiet --manifest-path tools/wgsl-check/Cargo.toml`
//! (or `npm run check:shaders`). Exits non-zero if any shader fails.
//!
//! `#include "file.wgsl"` directives (same directory only) are resolved
//! before parsing — mirroring Godot's `#include "lm_common_inc.glsl"`.
//! The identical resolution lives in @lightmapper/shaders
//! (packages/shaders/src/index.ts); keep the two in lock-step.

use std::fs;
use std::path::{Path, PathBuf};

fn skip_dir(name: &str) -> bool {
    matches!(name, "node_modules" | ".git" | "target" | "dist")
}

/// Recursively inline `#include "name.wgsl"` lines (same-directory includes).
/// Each file is inlined at most once per composition — the same include-once
/// semantics as Godot's shader preprocessor.
fn resolve_includes(path: &Path, included: &mut Vec<PathBuf>) -> Result<String, String> {
    let source = fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let dir = path.parent().unwrap_or(Path::new("."));
    let mut out = String::new();
    for line in source.lines() {
        let trimmed = line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("#include") {
            let rest = rest.trim();
            if rest.starts_with('"') && rest.ends_with('"') && rest.len() >= 2 {
                let name = &rest[1..rest.len() - 1];
                let include_path = dir.join(name);
                if !include_path.is_file() {
                    return Err(format!("include not found: {}", include_path.display()));
                }
                let canonical = include_path.canonicalize().map_err(|e| e.to_string())?;
                if included.contains(&canonical) {
                    continue; // already inlined (include-once)
                }
                included.push(canonical);
                let resolved = resolve_includes(&include_path, included);
                out.push_str(&resolved?);
                out.push('\n');
                continue;
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    Ok(out)
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
        let mut included = vec![path.canonicalize()?];
        let source = match resolve_includes(path, &mut included) {
            Ok(source) => source,
            Err(err) => {
                eprintln!("FAIL include  {}: {}", path.display(), err);
                failed = true;
                continue;
            }
        };
        let module = match naga::front::wgsl::parse_str(&source) {
            Ok(module) => module,
            Err(err) => {
                eprintln!("FAIL parse    {}:\n{}", path.display(), err.emit_to_string(&source));
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
                eprintln!("FAIL validate {}:\n{}", path.strip_prefix(&root).unwrap_or(path).display(), err.emit_to_string(&source));
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
