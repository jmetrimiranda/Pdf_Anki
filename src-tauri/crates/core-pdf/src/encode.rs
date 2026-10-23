use crate::PdfError;

/// Encodes straight RGBA8 as PNG.
pub fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, PdfError> {
    let expected = width as usize * height as usize * 4;
    if width == 0 || height == 0 || rgba.len() != expected {
        return Err(PdfError::Render(format!(
            "{width}x{height} raster with {} bytes",
            rgba.len()
        )));
    }
    let encode_err = |e: png::EncodingError| PdfError::Render(format!("png: {e}"));
    let mut out = Vec::with_capacity(expected / 4);
    let mut encoder = png::Encoder::new(&mut out, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Fast);
    let mut writer = encoder.write_header().map_err(encode_err)?;
    writer.write_image_data(rgba).map_err(encode_err)?;
    writer.finish().map_err(encode_err)?;
    Ok(out)
}
