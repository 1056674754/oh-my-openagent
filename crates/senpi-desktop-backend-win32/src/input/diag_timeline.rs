//! #9095 diagnostic (temporary): one stderr line per step of a foreground
//! pointer action, stamped with the QPC counter the QA hosts also log, with
//! the cursor, the foreground window and the top-level window at the point.

use windows_sys::Win32::Foundation::POINT;
use windows_sys::Win32::System::Performance::QueryPerformanceCounter;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, GetCursorPos, GetForegroundWindow, WindowFromPoint, GA_ROOT};

pub(super) fn mark(label: &str, point: Option<(i32, i32)>) {
    let mut ticks = 0i64;
    let mut cursor = POINT { x: 0, y: 0 };
    // SAFETY: [FFI] writable out slots; the other calls take scalars.
    let (foreground, at) = unsafe {
        QueryPerformanceCounter(&raw mut ticks);
        GetCursorPos(&raw mut cursor);
        let at = point.map(|(x, y)| GetAncestor(WindowFromPoint(POINT { x, y }), GA_ROOT).addr());
        (GetForegroundWindow().addr(), at)
    };
    eprintln!(
        "diag9095 {ticks} {label} cursor=({},{}) foreground={foreground} point={point:?} root_at_point={at:?}",
        cursor.x, cursor.y
    );
}
