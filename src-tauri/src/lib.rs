//! Native side of the photo annotation tool.
//!
//! The webview does all drawing; these commands only touch things the
//! browser sandbox cannot: reading/writing files at arbitrary paths and
//! moving images in and out of the system clipboard.

use std::io::Cursor;
use std::path::Path;

use image::{ImageBuffer, ImageFormat, Rgba};
use tauri::ipc::{InvokeBody, Request, Response};

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err("binary payload expected".to_string()),
    }
}

fn header_path(request: &Request<'_>) -> Result<String, String> {
    let value = request
        .headers()
        .get("x-path")
        .ok_or_else(|| "x-path header missing".to_string())?
        .to_str()
        .map_err(|e| e.to_string())?;
    Ok(percent_encoding::percent_decode_str(value)
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .into_owned())
}

/// Read a file and hand its bytes to the webview as an ArrayBuffer.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    Ok(Response::new(bytes))
}

/// Write the raw request body to the path given in the `x-path` header
/// (percent-encoded so that non-ASCII paths survive the header).
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = header_path(&request)?;
    let bytes = raw_body(&request)?;
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

/// Return the clipboard image as PNG bytes, or an error when there is none.
#[tauri::command]
fn clipboard_read_image() -> Result<Response, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = clipboard
        .get_image()
        .map_err(|_| "클립보드에 이미지가 없습니다".to_string())?;
    let width = img.width as u32;
    let height = img.height as u32;
    let mut rgba = img.bytes.into_owned();
    // Some Windows apps put 32-bit bitmaps on the clipboard with an all-zero
    // alpha channel; treat those as fully opaque instead of invisible.
    if rgba.chunks_exact(4).all(|px| px[3] == 0) {
        for px in rgba.chunks_exact_mut(4) {
            px[3] = 255;
        }
    }
    let buffer: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(width, height, rgba)
        .ok_or_else(|| "clipboard image has an unexpected size".to_string())?;
    let mut png = Cursor::new(Vec::new());
    buffer
        .write_to(&mut png, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(Response::new(png.into_inner()))
}

/// Put the PNG in the raw request body onto the clipboard as a bitmap.
#[tauri::command]
fn clipboard_write_image(request: Request<'_>) -> Result<(), String> {
    let bytes = raw_body(&request)?;
    let decoded = image::load_from_memory_with_format(&bytes, ImageFormat::Png)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    let (width, height) = decoded.dimensions();
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard
        .set_image(arboard::ImageData {
            width: width as usize,
            height: height as usize,
            bytes: decoded.into_raw().into(),
        })
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            clipboard_read_image,
            clipboard_write_image
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
