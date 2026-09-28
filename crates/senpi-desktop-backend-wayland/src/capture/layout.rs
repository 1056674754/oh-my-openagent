//! Logical geometry for capture pixels that arrived without it: the
//! Screenshot-portal fallback image, and a ScreenCast stream that reported
//! no logical size. The connected libei session's absolute-pointer regions
//! are the compositor's own statement of the logical layout (and per-region
//! scale) that input coordinates use, so they decide the mapping. An image
//! is accepted only when it is exactly that layout at one uniform scale;
//! anything else leaves the geometry unknown and the frame pixels-only.

use senpi_desktop_core::types::DesktopDisplay;

/// One libei device region, in the compositor's logical coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EisRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
    /// Physical pixels per logical pixel; `<= 0` or non-finite when unset.
    pub scale: f32,
}

/// Displays for a `width` x `height` image of the whole `regions` layout,
/// ids `{id_prefix}{index}`, or `None` when the image is not that layout.
pub fn derive_displays(
    width: u32,
    height: u32,
    regions: &[EisRegion],
    id_prefix: &str,
    name: &str,
) -> Option<Vec<DesktopDisplay>> {
    let _ = (width, height, regions, id_prefix, name);
    None
}

/// Logical size of one ScreenCast monitor stream that reported none: the
/// single region at the monitor's logical `position`, accepted only when
/// the `width` x `height` frame is that region at one scale.
pub fn monitor_size(position: (i32, i32), width: u32, height: u32, regions: &[EisRegion]) -> Option<(u32, u32)> {
    let _ = (position, width, height, regions);
    None
}
