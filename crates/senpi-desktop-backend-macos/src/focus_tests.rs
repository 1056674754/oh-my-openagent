use super::{first_front_window, hand_back, HandBack, WindowInfo};

#[test]
fn chooses_first_visible_normal_window_of_frontmost_process() {
    // Given: the window server lists overlays and another process ahead of two document windows.
    let windows = [
        WindowInfo {
            pid: 12,
            window_number: 1,
            layer: 0,
            on_screen: true,
        },
        WindowInfo {
            pid: 7,
            window_number: 2,
            layer: 3,
            on_screen: true,
        },
        WindowInfo {
            pid: 7,
            window_number: 3,
            layer: 0,
            on_screen: false,
        },
        WindowInfo {
            pid: 7,
            window_number: 4,
            layer: 0,
            on_screen: true,
        },
        WindowInfo {
            pid: 7,
            window_number: 5,
            layer: 0,
            on_screen: true,
        },
    ];
    // When: the frontmost app is process 7.
    let selected = first_front_window(&windows, 7);
    // Then: the front-to-back first visible layer-zero document wins.
    assert_eq!(selected, Some(4));
}

#[test]
fn returns_none_when_no_normal_on_screen_window_matches() {
    // Given: only off-screen and non-normal windows belong to the frontmost process.
    let windows = [
        WindowInfo {
            pid: 7,
            window_number: 2,
            layer: 0,
            on_screen: false,
        },
        WindowInfo {
            pid: 7,
            window_number: 3,
            layer: 1,
            on_screen: true,
        },
    ];
    // When: selecting its front window.
    let selected = first_front_window(&windows, 7);
    // Then: no window identity is falsely captured.
    assert_eq!(selected, None);
}

#[test]
fn hand_back_reactivates_only_while_the_engine_activation_is_front() {
    // Given: Terminal (10) was front, the engine made TextEdit (20) key.
    // Then: TextEdit still front -> give focus back to Terminal.
    assert_eq!(hand_back(10, Some(20), Some(20)), HandBack::Reactivate);
    // Terminal already front again -> nothing to do.
    assert_eq!(hand_back(10, Some(20), Some(10)), HandBack::AlreadyFront);
    // The user switched to Finder (30) meanwhile -> leave Finder front.
    assert_eq!(hand_back(10, Some(20), Some(30)), HandBack::UserMovedOn);
    // The engine made nothing key and the snapshot is not front -> the user moved on.
    assert_eq!(hand_back(10, None, Some(30)), HandBack::UserMovedOn);
    // The front application is unknown -> keep the previous behaviour.
    assert_eq!(hand_back(10, Some(20), None), HandBack::Reactivate);
    assert_eq!(hand_back(10, None, None), HandBack::AlreadyFront);
}
