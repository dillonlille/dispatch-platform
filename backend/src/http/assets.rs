//! The built dashboard, loaded once and served from memory.
use crate::{Error, Result, State, crypto, ensure};
use axum::{
    body::Body,
    http::{HeaderMap, Method, StatusCode},
    response::Response,
};
use serde_json::Value;
use std::collections::HashMap;

pub fn browser_update_ready(config: &crate::config::Config) -> bool {
    let channel = if config.environment == "production" {
        "production"
    } else {
        "dev"
    };
    let platform = config.platform();
    let status = std::fs::read(platform.join(format!("{channel}-update.json")))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    !platform.join(format!("{channel}-activation.json")).exists()
        && (config.development
            || status.is_some_and(|s| s["status"] == "ready" && s["digest"] == config.release))
}

pub struct Asset {
    bytes: axum::body::Bytes,
    etag: String,
    mime: &'static str,
    cache: &'static str,
}
// Artifacts are immutable for the process lifetime. Deployment restarts the core.
// Load once so both GET and HEAD need no filesystem work on the request path.
pub fn assets(root: &std::path::Path, release: &str) -> Result<HashMap<String, Asset>> {
    let mut files = vec![("/".to_owned(), root.join("index.html"))];
    let directory = root.join("assets");
    if directory.is_dir() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                files.push((
                    format!("/assets/{}", entry.file_name().to_string_lossy()),
                    entry.path(),
                ));
            }
        }
    }
    let mut result = HashMap::new();
    let mut size = 0;
    for (route, file) in files {
        if !file.is_file() {
            continue;
        }
        let mut bytes = std::fs::read(&file)?;
        if route == "/" {
            let html = String::from_utf8_lossy(&bytes);
            bytes = html
                .replacen(
                    "</head>",
                    &format!(
                        "<meta name=\"dispatch-build\" content=\"{}\"></head>",
                        crypto::sha(release.as_bytes())
                    ),
                    1,
                )
                .into_bytes();
        }
        size += bytes.len();
        ensure(size <= 64 * 1024 * 1024, "dashboard_too_large", 503)?;
        let extension = file.extension().and_then(|s| s.to_str()).unwrap_or("");
        let stem = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .as_bytes();
        let hashed = ["js", "css"].contains(&extension)
            && stem.len() > 9
            && stem[stem.len() - 9] == b'-'
            && stem[stem.len() - 8..]
                .iter()
                .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-');
        let mime = match extension {
            "html" => "text/html; charset=utf-8",
            "js" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "woff2" => "font/woff2",
            _ => "application/octet-stream",
        };
        result.insert(
            route.clone(),
            Asset {
                etag: format!("\"{}\"", crypto::sha(&bytes)),
                bytes: bytes.into(),
                mime,
                cache: if route == "/" {
                    "no-store"
                } else if hashed {
                    "public, max-age=31536000, immutable"
                } else {
                    "public, no-cache"
                },
            },
        );
    }
    Ok(result)
}
/// `GET` and `HEAD` of `/` and `/assets/*`, with an ETag so browsers revalidate cheaply.
pub fn serve(state: &State, method: &Method, path: &str, headers: &HeaderMap) -> Result<Response> {
    ensure(
        !path.contains("..") && !path.contains('%') && !path.contains('\\'),
        "not_found",
        404,
    )?;
    let asset = state
        .assets
        .get(path)
        .ok_or_else(|| Error::new("not_found", 404))?;
    let unchanged = path != "/"
        && headers
            .get("if-none-match")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|tags| {
                tags.split(',').any(|tag| {
                    tag.trim().trim_start_matches("W/") == asset.etag || tag.trim() == "*"
                })
            });
    let mut reply = Response::new(if method == Method::HEAD || unchanged {
        Body::empty()
    } else {
        Body::from(asset.bytes.clone())
    });
    if unchanged {
        *reply.status_mut() = StatusCode::NOT_MODIFIED;
    }
    let h = reply.headers_mut();
    h.insert("content-type", asset.mime.parse().unwrap());
    h.insert("etag", asset.etag.parse().unwrap());
    h.insert("cache-control", asset.cache.parse().unwrap());
    if !unchanged {
        h.insert(
            "content-length",
            asset.bytes.len().to_string().parse().unwrap(),
        );
    }
    Ok(reply)
}
