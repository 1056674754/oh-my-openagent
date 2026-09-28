//! #9095 diagnostic (temporary): where does a `SendInput` cursor move land
//! in this process's context? Measures `GetCursorPos` around an absolute
//! virtual-desktop move (the engine's `system::move_to`), a primary-monitor
//! absolute move, a relative move, and `SetCursorPos`, and records what a
//! `WH_MOUSE_LL` hook saw for each, the virtual-screen metrics, the process
//! DPI awareness, and the pointer-device facts. Prints `diag.*` lines only;
//! asserts nothing.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use senpi_desktop_core::types::DisplaySelector;
use windows_sys::Win32::Foundation::{POINT, RECT};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::{
    GetAwarenessFromDpiAwarenessContext, GetDpiAwarenessContextForProcess, GetDpiForSystem,
    GetThreadDpiAwarenessContext,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetLastInputInfo, SendInput, INPUT, LASTINPUTINFO, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE,
};
use windows_sys::Win32::UI::WindowsAndMessaging as wm;

use super::events::mouse_event;
use super::live_tests::LIVE_INPUT;
use super::messages::absolute_coordinate;
use super::system;
use crate::Win32Backend;

static HOOKED: Mutex<Vec<(u32, i32, i32, u32)>> = Mutex::new(Vec::new());

unsafe extern "system" fn hook(code: i32, wparam: usize, lparam: isize) -> isize {
    if code >= 0 {
        // SAFETY: [FFI] for WH_MOUSE_LL with code >= 0, lparam points to a
        // valid MSLLHOOKSTRUCT for the duration of the call.
        let info = unsafe {
            &*std::ptr::with_exposed_provenance::<wm::MSLLHOOKSTRUCT>(usize::from_ne_bytes(lparam.to_ne_bytes()))
        };
        HOOKED
            .lock()
            .push((u32::try_from(wparam).unwrap_or(0), info.pt.x, info.pt.y, info.flags));
    }
    // SAFETY: [FFI] passes the hook chain on unchanged.
    unsafe { wm::CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

struct Hook {
    thread: u32,
    join: Option<thread::JoinHandle<()>>,
}

impl Hook {
    fn install() -> Self {
        let (ready, installed) = mpsc::channel();
        let join = thread::spawn(move || {
            let mut message = wm::MSG::default();
            // SAFETY: [FFI] creates this thread's message queue.
            unsafe { wm::PeekMessageW(&raw mut message, std::ptr::null_mut(), 0, 0, wm::PM_NOREMOVE) };
            // SAFETY: [FFI] null selects this executable; the hook proc lives
            // for the whole process.
            let handle = unsafe {
                wm::SetWindowsHookExW(wm::WH_MOUSE_LL, Some(hook), GetModuleHandleW(std::ptr::null()), 0)
            };
            // SAFETY: [FFI] no arguments.
            let id = unsafe { GetCurrentThreadId() };
            let _sent = ready.send((id, !handle.is_null()));
            // SAFETY: [FFI] `message` is writable; WM_QUIT ends the loop.
            while unsafe { wm::GetMessageW(&raw mut message, std::ptr::null_mut(), 0, 0) } > 0 {}
            if !handle.is_null() {
                // SAFETY: [FFI] the handle this thread installed.
                unsafe { wm::UnhookWindowsHookEx(handle) };
            }
        });
        let (thread, ok) = installed.recv().unwrap();
        println!("diag.hook installed={ok}");
        Self {
            thread,
            join: Some(join),
        }
    }
}

impl Drop for Hook {
    fn drop(&mut self) {
        // SAFETY: [FFI] posts WM_QUIT to the hook thread's queue.
        unsafe { wm::PostThreadMessageW(self.thread, wm::WM_QUIT, 0, 0) };
        if let Some(join) = self.join.take() {
            let _joined = join.join();
        }
    }
}

fn cursor() -> (i32, i32) {
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: [FFI] writable out slot.
    let ok = unsafe { wm::GetCursorPos(&raw mut point) };
    if ok == 0 {
        (i32::MIN, i32::MIN)
    } else {
        (point.x, point.y)
    }
}

fn last_input() -> u32 {
    let mut info = LASTINPUTINFO {
        cbSize: u32::try_from(size_of::<LASTINPUTINFO>()).unwrap(),
        dwTime: 0,
    };
    // SAFETY: [FFI] `info` is writable with its size set.
    unsafe { GetLastInputInfo(&raw mut info) };
    info.dwTime
}

/// Waits until the raw input thread routed everything sent so far (the
/// barrier sentinel's async key state), then samples the cursor for 300 ms.
fn settle(step: &str, intended: Option<(i32, i32)>) {
    let routed = system::barrier_key(true, None).is_ok() && {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !system::barrier_key_down() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(1));
        }
        system::barrier_key_down()
    };
    let _released = system::barrier_key(false, None);
    let at_barrier = cursor();
    let started = Instant::now();
    let mut samples = vec![at_barrier];
    while started.elapsed() < Duration::from_millis(300) {
        thread::sleep(Duration::from_millis(20));
        let now = cursor();
        if samples.last() != Some(&now) {
            samples.push(now);
        }
    }
    let hooked: Vec<_> = std::mem::take(&mut *HOOKED.lock())
        .into_iter()
        .filter(|(message, ..)| *message == wm::WM_MOUSEMOVE)
        .collect();
    println!(
        "diag.step {step} intended={intended:?} routed={routed} at_barrier={at_barrier:?} \
         samples_300ms={samples:?} last_input={} hook_moves={hooked:?}",
        last_input()
    );
}

fn send(event: INPUT) -> u32 {
    // SAFETY: [FFI] one initialized INPUT of the exact size.
    unsafe { SendInput(1, &raw const event, i32::try_from(size_of::<INPUT>()).unwrap()) }
}

fn awareness(label: &str) {
    // SAFETY: [FFI] null selects this process; the context is only decoded.
    let (process, thread, system_dpi) = unsafe {
        (
            GetAwarenessFromDpiAwarenessContext(GetDpiAwarenessContextForProcess(std::ptr::null_mut())),
            GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()),
            GetDpiForSystem(),
        )
    };
    println!("diag.dpi {label} process_awareness={process} thread_awareness={thread} system_dpi={system_dpi}");
}

#[test]
#[ignore = "live: #9095 diagnostic, needs the hosted Windows interactive desktop"]
fn diag_9095_cursor_moves() {
    let _input = LIVE_INPUT.lock();
    awareness("before-backend");
    let backend = Win32Backend::new(DisplaySelector::All);
    awareness("after-backend");
    println!("diag.backend ok={}", backend.is_ok());
    let metric = |index| {
        // SAFETY: [FFI] scalar index.
        unsafe { wm::GetSystemMetrics(index) }
    };
    let (vx, vy, vw, vh) = (
        metric(wm::SM_XVIRTUALSCREEN),
        metric(wm::SM_YVIRTUALSCREEN),
        metric(wm::SM_CXVIRTUALSCREEN),
        metric(wm::SM_CYVIRTUALSCREEN),
    );
    let (sw, sh) = (metric(wm::SM_CXSCREEN), metric(wm::SM_CYSCREEN));
    println!(
        "diag.metrics virtual=({vx},{vy},{vw},{vh}) primary=({sw},{sh}) mouse_present={} mouse_buttons={} \
         remote_session={} monitors={}",
        metric(wm::SM_MOUSEPRESENT),
        metric(wm::SM_CMOUSEBUTTONS),
        metric(wm::SM_REMOTESESSION),
        metric(wm::SM_CMONITORS),
    );
    let mut info = wm::CURSORINFO {
        cbSize: u32::try_from(size_of::<wm::CURSORINFO>()).unwrap(),
        ..wm::CURSORINFO::default()
    };
    // SAFETY: [FFI] `info` is writable with its size set.
    let got_info = unsafe { wm::GetCursorInfo(&raw mut info) };
    let mut clip = RECT::default();
    // SAFETY: [FFI] writable out slot.
    let got_clip = unsafe { wm::GetClipCursor(&raw mut clip) };
    let mut mouse = [0i32; 3];
    let mut speed = 0i32;
    // SAFETY: [FFI] SPI_GETMOUSE writes three ints, SPI_GETMOUSESPEED one.
    unsafe {
        wm::SystemParametersInfoW(wm::SPI_GETMOUSE, 0, mouse.as_mut_ptr().cast(), 0);
        wm::SystemParametersInfoW(wm::SPI_GETMOUSESPEED, 0, (&raw mut speed).cast(), 0);
    }
    println!(
        "diag.cursor info_ok={got_info} flags={:#x} info_pos=({},{}) clip_ok={got_clip} clip=({},{},{},{}) \
         spi_mouse={mouse:?} spi_speed={speed} start={:?}",
        info.flags, info.ptScreenPos.x, info.ptScreenPos.y, clip.left, clip.top, clip.right, clip.bottom, cursor()
    );

    let hook = Hook::install();
    let (cx, cy) = (sw / 2, sh / 2);
    let a = (cx - 200, cy - 150);
    // SAFETY: [FFI] plain values.
    let set_ok = unsafe { wm::SetCursorPos(a.0, a.1) };
    println!("diag.setcursorpos_a ok={set_ok}");
    settle("setcursorpos-a", Some(a));

    let b = (cx + 150, cy + 100);
    let moved = system::move_to(b, None);
    println!("diag.move_to_virtualdesk result={moved:?}");
    settle("sendinput-absolute-virtualdesk", Some(b));

    let b2 = (cx - 120, cy + 140);
    let (Some(dx), Some(dy)) = (absolute_coordinate(b2.0, 0, sw), absolute_coordinate(b2.1, 0, sh)) else {
        panic!("primary geometry is degenerate");
    };
    let sent = send(mouse_event(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, 0, dx, dy));
    println!("diag.absolute_primary sent={sent} normalized=({dx},{dy})");
    settle("sendinput-absolute-primary", Some(b2));

    let before_relative = cursor();
    let sent = send(mouse_event(MOUSEEVENTF_MOVE, 0, 40, 30));
    println!("diag.relative sent={sent} from={before_relative:?}");
    settle(
        "sendinput-relative-40-30",
        Some((before_relative.0 + 40, before_relative.1 + 30)),
    );

    let c = (cx + 60, cy - 90);
    // SAFETY: [FFI] plain values.
    let set_ok = unsafe { wm::SetCursorPos(c.0, c.1) };
    println!("diag.setcursorpos_c ok={set_ok}");
    settle("setcursorpos-c", Some(c));

    let d = (cx - 30, cy + 40);
    let moved = system::move_to(d, None);
    println!("diag.move_to_virtualdesk_after_set result={moved:?}");
    settle("sendinput-absolute-virtualdesk-after-setcursorpos", Some(d));
    drop(hook);
}
