use image::RgbaImage;
use senpi_desktop_core::error::CoreResult;
use senpi_desktop_core::types::{DesktopDisplay, DisplaySelector};

pub(crate) fn select_capture(
    _selector: &DisplaySelector,
    image: RgbaImage,
    displays: Vec<DesktopDisplay>,
) -> CoreResult<(RgbaImage, Vec<DesktopDisplay>)> {
    Ok((image, displays))
}
