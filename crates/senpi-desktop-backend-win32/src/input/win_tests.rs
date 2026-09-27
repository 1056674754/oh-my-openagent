//! Windows-only, display-free input tests: the pure tables pinned to
//! `windows-sys`, and background delivery into message-only windows of a
//! chosen class that this test thread owns, so every posted message lands in
//! this thread's queue where the test reads it back.

use senpi_desktop_core::backend::DeliveryMode;
use senpi_desktop_core::error::ErrorCode;
use senpi_desktop_core::keys::KeyName;
use senpi_desktop_core::types::Target;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse as kbm;
use windows_sys::Win32::UI::WindowsAndMessaging as wm;

use super::held::{HeldKey, Route};
use super::native::Window;
use super::{keys, messages, Win32Input};
use crate::integrity;
use crate::stop_path::chord;

#[test]
fn virtual_keys_and_messages_match_windows_sys() {
    let pairs: [(u32, u32); 16] = [
        (keys::VK_CONTROL.into(), kbm::VK_CONTROL.into()),
        (keys::VK_MENU.into(), kbm::VK_MENU.into()),
        (keys::VK_SHIFT.into(), kbm::VK_SHIFT.into()),
        (keys::VK_LWIN.into(), kbm::VK_LWIN.into()),
        (keys::VK_ESCAPE.into(), kbm::VK_ESCAPE.into()),
        (keys::VK_DELETE.into(), kbm::VK_DELETE.into()),
        (keys::VK_F1.into(), kbm::VK_F1.into()),
        (keys::VK_NUMLOCK.into(), kbm::VK_NUMLOCK.into()),
        (keys::WM_KEYDOWN, wm::WM_KEYDOWN),
        (keys::WM_SYSKEYUP, wm::WM_SYSKEYUP),
        (messages::WM_CHAR, wm::WM_CHAR),
        (messages::WM_MOUSEHWHEEL, wm::WM_MOUSEHWHEEL),
        (messages::WHEEL_DELTA.unsigned_abs(), wm::WHEEL_DELTA),
        (chord::MOD_CONTROL, kbm::MOD_CONTROL),
        (chord::MOD_WIN, kbm::MOD_WIN),
        (chord::MOD_NOREPEAT, kbm::MOD_NOREPEAT),
    ];
    for (index, (ours, theirs)) in pairs.into_iter().enumerate() {
        assert_eq!(ours, theirs, "pair {index}");
    }
}

/// A message-only window of class `class`, owned by the creating thread;
/// dropping it destroys the window and unregisters the class.
struct ProbeWindow {
    hwnd: HWND,
    class: Vec<u16>,
}

impl ProbeWindow {
    fn new(class: &str) -> Self {
        let class: Vec<u16> = class.encode_utf16().chain([0]).collect();
        // SAFETY: [FFI] test-only; a null name selects this executable.
        let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
        let registration = wm::WNDCLASSW {
            lpfnWndProc: Some(wm::DefWindowProcW),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..wm::WNDCLASSW::default()
        };
        // SAFETY: [FFI] `registration` and the class name outlive the call.
        assert_ne!(unsafe { wm::RegisterClassW(&raw const registration) }, 0);
        // SAFETY: [FFI] the class was just registered; a message-only parent
        // needs no desktop.
        let hwnd = unsafe {
            wm::CreateWindowExW(
                0,
                class.as_ptr(),
                class.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                wm::HWND_MESSAGE,
                std::ptr::null_mut(),
                instance,
                std::ptr::null(),
            )
        };
        assert!(!hwnd.is_null(), "CreateWindowExW failed");
        Self { hwnd, class }
    }

    fn id(&self) -> String {
        self.hwnd.addr().to_string()
    }

    /// Every queued message of this window, oldest first.
    fn drain(&self) -> Vec<(u32, usize)> {
        let mut message = wm::MSG::default();
        let mut seen = Vec::new();
        // SAFETY: [FFI] `message` is a valid out slot.
        while unsafe { wm::PeekMessageW(&raw mut message, self.hwnd, 0, 0, wm::PM_REMOVE) } != 0 {
            seen.push((message.message, message.wParam));
        }
        seen
    }
}

impl Drop for ProbeWindow {
    fn drop(&mut self) {
        // SAFETY: [FFI] this thread created the window and registered the
        // class; nothing else refers to either.
        unsafe {
            wm::DestroyWindow(self.hwnd);
            wm::UnregisterClassW(self.class.as_ptr(), GetModuleHandleW(std::ptr::null()));
        }
    }
}

fn input() -> Win32Input {
    Win32Input::new(integrity::current_process().unwrap()).unwrap()
}

#[test]
fn pointer_routing_selects_the_deepest_enabled_child_window() {
    let class: Vec<u16> = "SenpiChildRouteProbe"
        .encode_utf16()
        .chain([0])
        .collect();
    let button: Vec<u16> = "BUTTON".encode_utf16().chain([0]).collect();
    // SAFETY: [Category 8 - FFI boundary] test-only class storage and window
    // handles remain live until explicit teardown below.
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let registration = wm::WNDCLASSW {
            lpfnWndProc: Some(wm::DefWindowProcW),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..wm::WNDCLASSW::default()
        };
        assert_ne!(wm::RegisterClassW(&raw const registration), 0);
        let root = wm::CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            wm::WS_OVERLAPPEDWINDOW | wm::WS_VISIBLE,
            100,
            100,
            320,
            240,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        assert!(!root.is_null());
        let child = wm::CreateWindowExW(
            0,
            button.as_ptr(),
            button.as_ptr(),
            wm::WS_CHILD | wm::WS_VISIBLE,
            20,
            20,
            120,
            60,
            root,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        assert!(!child.is_null());
        let mut rect = windows_sys::Win32::Foundation::RECT::default();
        assert_ne!(wm::GetWindowRect(child, &raw mut rect), 0);
        let point = windows_sys::Win32::Foundation::POINT {
            x: rect.left + (rect.right - rect.left) / 2,
            y: rect.top + (rect.bottom - rect.top) / 2,
        };

        let routed = Window::from_hwnd(root)
            .unwrap()
            .deepest_child(point)
            .unwrap()
            .0;

        assert_eq!(routed.address(), child.addr());
        wm::DestroyWindow(root);
        wm::UnregisterClassW(class.as_ptr(), instance);
    }
}

#[test]
fn background_text_reaches_an_unlisted_class_window() {
    // Given: a window of a class the matrix does not list
    let window = ProbeWindow::new("SomeCustomClass");
    // When
    let typed = input().type_text(&Target::Window(window.id()), "hi\n", DeliveryMode::Background);
    // Then: characters arrive as WM_CHAR and the newline as one Return
    // transition, never a raw carriage-return character.
    assert_eq!(typed, Ok(()));
    let messages = window.drain();
    let chars: Vec<usize> = messages
        .iter()
        .filter_map(|(message, unit)| (*message == wm::WM_CHAR).then_some(unit))
        .copied()
        .collect();
    let returns: Vec<u32> = messages
        .iter()
        .filter_map(|(message, unit)| {
            (*unit == usize::from(keys::VK_RETURN))
                .then_some(*message)
                .filter(|message| matches!(*message, wm::WM_KEYDOWN | wm::WM_KEYUP))
        })
        .collect();
    assert_eq!(chars, [usize::from(b'h'), usize::from(b'i')]);
    assert_eq!(returns, [wm::WM_KEYDOWN, wm::WM_KEYUP]);
}

#[test]
fn background_text_into_a_chromium_class_window_is_refused_naming_it() {
    // Given: a window of Chromium's frame class
    let window = ProbeWindow::new("Chrome_WidgetWin_1");
    // When
    let error = input()
        .type_text(&Target::Window(window.id()), "hi", DeliveryMode::Background)
        .unwrap_err();
    // Then: refused before anything was posted
    println!("code={} message={}", error.code.as_str(), error.message);
    assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
    assert!(error.message.contains("Chrome_WidgetWin_1"), "{}", error.message);
    assert_eq!(window.drain(), []);
}

#[test]
fn background_key_chord_releases_every_key_it_pressed() {
    // Given
    let window = ProbeWindow::new("SenpiChordProbe");
    let mut input = input();
    // When
    let sent = input.key_chord(
        &Target::Window(window.id()),
        &[KeyName::Ctrl, KeyName::F5],
        DeliveryMode::Background,
    );
    // Then: down in order, up in reverse, and nothing left held
    assert_eq!(sent, Ok(()));
    let f5 = usize::from(keys::VK_F1 + 4);
    let ctrl = usize::from(keys::VK_CONTROL);
    assert_eq!(
        window.drain(),
        [
            (wm::WM_KEYDOWN, ctrl),
            (wm::WM_KEYDOWN, f5),
            (wm::WM_KEYUP, f5),
            (wm::WM_KEYUP, ctrl)
        ]
    );
    assert!(input.held.is_empty());
}

#[test]
fn release_all_posts_the_release_of_a_key_left_held() {
    // Given: a posted key-down whose release never went out
    let window = ProbeWindow::new("SenpiReleaseProbe");
    let mut input = input();
    input.held.key_down(HeldKey {
        route: Route::Window(window.hwnd.addr()),
        vk: keys::VK_SHIFT,
    });
    // When
    let released = input.release_all();
    // Then
    assert_eq!(released, Ok(()));
    assert_eq!(window.drain(), [(wm::WM_KEYUP, usize::from(keys::VK_SHIFT))]);
    assert!(input.held.is_empty());
}

#[test]
fn a_malformed_window_id_is_an_invalid_target() {
    let error = input()
        .type_text(
            &Target::Window("not-a-hwnd".into()),
            "x",
            DeliveryMode::Background,
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidTarget);
}
