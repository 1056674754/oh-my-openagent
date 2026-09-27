//! `SendInput` primitives: synthesized events on the system input queue,
//! which reach whatever window has the foreground (keys) or lies under the
//! cursor (pointer). Absolute moves are normalized over the whole virtual
//! desktop, so every monitor is reachable.

use std::mem::size_of;

use senpi_desktop_core::backend::MouseButton;
use senpi_desktop_core::error::{CoreResult, DesktopError};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use super::messages::absolute_coordinate;
use super::native::{self, Window};

/// An unassigned virtual key (no layout or command maps it): the delivery
/// barrier's sentinel.
const VK_BARRIER: u16 = 0xE8;

/// Inserts `events` into the system input queue in one call, so no other
/// input interleaves with them.
fn send(events: &[INPUT], target: Option<Window>) -> CoreResult<()> {
    let size = i32::try_from(size_of::<INPUT>()).unwrap_or(i32::MAX);
    let count = u32::try_from(events.len())
        .map_err(|_| DesktopError::input_failed("too many input events for one SendInput call"))?;
    if target.is_some_and(|target| native::foreground() != Some(target)) {
        return Err(DesktopError::input_failed(
            "the exact target lost foreground; stopped sending foreground input",
        ));
    }
    // SAFETY: [FFI] `events` is `count` fully initialized INPUTs that Win32
    // copies synchronously; `size` is the exact size of one.
    let sent = unsafe { SendInput(count, events.as_ptr(), size) };
    if sent == count {
        return Ok(());
    }
    let accepted = usize::try_from(sent).unwrap_or(usize::MAX).min(events.len());
    let mut cleanup = Ok(());
    for release in pending_input_releases(&events[..accepted]).iter().rev() {
        // SAFETY: [Category 8 - FFI boundary] `release` is one initialized
        // INPUT built by this module. Win32 copies it synchronously.
        if unsafe { SendInput(1, release, size) } != 1 {
            cleanup = Err(DesktopError::input_failed(
                "Win32 SendInput could not release an inserted input",
            ));
        }
    }
    let failure = DesktopError::input_failed(format!(
        "Win32 SendInput inserted {sent} of {count} events; the action may be partially applied: {}",
        std::io::Error::last_os_error()
    ));
    match cleanup {
        Ok(()) => Err(failure),
        Err(cleanup) => Err(DesktopError::input_failed(format!(
            "{}; cleanup also failed: {}",
            failure.message, cleanup.message
        ))),
    }
}

fn pending_input_releases(events: &[INPUT]) -> Vec<INPUT> {
    let mut pending = Vec::new();
    for event in events {
        let Some((down, release)) = release_transition(event) else {
            continue;
        };
        let previous = pending.iter().position(|held| same_release(held, &release));
        if down {
            if previous.is_none() {
                pending.push(release);
            }
        } else if let Some(index) = previous {
            pending.remove(index);
        }
    }
    pending
}

fn release_transition(event: &INPUT) -> Option<(bool, INPUT)> {
    // SAFETY: [Category 5 - Invalid values] every INPUT in this module is
    // constructed with a matching type tag and initialized union member.
    unsafe {
        match event.r#type {
            INPUT_KEYBOARD => {
                let key = event.Anonymous.ki;
                Some((
                    key.dwFlags & KEYEVENTF_KEYUP == 0,
                    key_event(key.wVk, key.wScan, key.dwFlags | KEYEVENTF_KEYUP),
                ))
            }
            INPUT_MOUSE => {
                let flags = event.Anonymous.mi.dwFlags;
                for (down, up) in [
                    (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                    (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                    (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                ] {
                    if flags & (down | up) != 0 {
                        return Some((flags & down != 0, mouse_event(up, 0, 0, 0)));
                    }
                }
                None
            }
            _ => None,
        }
    }
}

const fn same_release(left: &INPUT, right: &INPUT) -> bool {
    if left.r#type != right.r#type {
        return false;
    }
    // SAFETY: [Category 5 - Invalid values] matching tags select initialized
    // members produced by `release_transition`.
    unsafe {
        if left.r#type == INPUT_KEYBOARD {
            let a = left.Anonymous.ki;
            let b = right.Anonymous.ki;
            a.wVk == b.wVk && a.wScan == b.wScan && a.dwFlags == b.dwFlags
        } else {
            left.Anonymous.mi.dwFlags == right.Anonymous.mi.dwFlags
        }
    }
}

const fn mouse_event(flags: u32, data: i32, dx: i32, dy: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: u32::from_ne_bytes(data.to_ne_bytes()),
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

const fn key_event(vk: u16, scan: u16, flags: u32) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Presses (`down`) or releases virtual key `vk`.
pub(super) fn key(vk: u16, down: bool, target: Option<Window>) -> CoreResult<()> {
    send(
        &[key_event(vk, 0, if down { 0 } else { KEYEVENTF_KEYUP })],
        target,
    )
}

/// Types UTF-16 units layout-independently (`KEYEVENTF_UNICODE`), all in
/// one `SendInput` call.
pub(super) fn unicode_text(
    units: impl Iterator<Item = u16>,
    target: Option<Window>,
) -> CoreResult<()> {
    let events = units
        .flat_map(|unit| {
            [
                key_event(0, unit, KEYEVENTF_UNICODE),
                key_event(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
            ]
        })
        .collect::<Vec<_>>();
    if events.is_empty() {
        return Ok(());
    }
    send(&events, target)
}

/// Presses (`down`) or releases the barrier sentinel key.
pub(super) fn barrier_key(down: bool, target: Option<Window>) -> CoreResult<()> {
    key(VK_BARRIER, down, target)
}

/// Whether the raw input thread has processed a press of the sentinel key
/// that no release has followed yet: it updates the async key state as it
/// routes each event, in queue order.
pub(super) fn barrier_key_down() -> bool {
    // SAFETY: [FFI] a scalar read of the global async key state.
    let state = unsafe { GetAsyncKeyState(i32::from(VK_BARRIER)) };
    state < 0
}

/// Makes this process the source of the last input event with a zero
/// relative mouse move (no motion, no button). `SetForegroundWindow` only
/// succeeds for the process that received the last input event, which an
/// engine driven over stdio never is on its own.
pub(super) fn claim_last_input() -> CoreResult<()> {
    send(&[mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0)], None)
}

/// Moves the cursor to a physical virtual-desktop point.
pub(super) fn move_to((x, y): (i32, i32), target: Option<Window>) -> CoreResult<()> {
    // SAFETY: [FFI] `GetSystemMetrics` takes a scalar index and has no
    // preconditions.
    let (origin_x, origin_y, width, height) = unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    };
    let (Some(dx), Some(dy)) = (
        absolute_coordinate(x, origin_x, width),
        absolute_coordinate(y, origin_y, height),
    ) else {
        return Err(DesktopError::input_failed(
            "Win32 virtual desktop geometry is unavailable",
        ));
    };
    let flags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
    send(&[mouse_event(flags, 0, dx, dy)], target)
}

/// Presses (`down`) or releases `button` where the cursor is.
pub(super) fn button(
    button: MouseButton,
    down: bool,
    target: Option<Window>,
) -> CoreResult<()> {
    let flags = match (button, down) {
        (MouseButton::Left, true) => MOUSEEVENTF_LEFTDOWN,
        (MouseButton::Left, false) => MOUSEEVENTF_LEFTUP,
        (MouseButton::Right, true) => MOUSEEVENTF_RIGHTDOWN,
        (MouseButton::Right, false) => MOUSEEVENTF_RIGHTUP,
        (MouseButton::Middle, true) => MOUSEEVENTF_MIDDLEDOWN,
        (MouseButton::Middle, false) => MOUSEEVENTF_MIDDLEUP,
    };
    send(&[mouse_event(flags, 0, 0, 0)], target)
}

/// One wheel event of `delta` (multiples of `WHEEL_DELTA`) on an axis.
pub(super) fn wheel(
    horizontal: bool,
    delta: i32,
    target: Option<Window>,
) -> CoreResult<()> {
    let flags = if horizontal {
        MOUSEEVENTF_HWHEEL
    } else {
        MOUSEEVENTF_WHEEL
    };
    send(&[mouse_event(flags, delta, 0, 0)], target)
}
