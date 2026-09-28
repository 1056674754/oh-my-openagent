//! The application the user sees in front, read live from WindowServer.

use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};

use crate::focus::{window_info, WindowInfo};
use crate::{launch_services, skylight};

/// The application the user sees in front: LaunchServices' front application
/// (the menu-bar owner). Without that SPI, WindowServer's front process when it
/// is a regular app, else the owner of the front-most on-screen normal-layer
/// window of a regular app; an accessory app's floating panel can be
/// WindowServer's front process (#9084). AppKit's view is the last resort; the
/// engine has no run loop to refresh it.
pub(crate) fn current_front_pid() -> Option<libc::pid_t> {
    if let Some(pid) = launch_services::front_application_pid() {
        return Some(pid);
    }
    let Some(front) = skylight::front_pid() else {
        return NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier());
    };
    let windows = window_info().unwrap_or_default();
    user_front_pid(front, &windows, is_regular_app)
}

fn is_regular_app(pid: libc::pid_t) -> bool {
    NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        .is_some_and(|app| app.activationPolicy() == NSApplicationActivationPolicy::Regular)
}

pub(crate) fn user_front_pid(
    front: libc::pid_t,
    windows: &[WindowInfo],
    is_regular: impl Fn(libc::pid_t) -> bool,
) -> Option<libc::pid_t> {
    if is_regular(front) {
        return Some(front);
    }
    windows
        .iter()
        .filter(|window| window.layer == 0 && window.on_screen)
        .filter_map(|window| libc::pid_t::try_from(window.pid).ok())
        .find(|&pid| is_regular(pid))
        .or(Some(front))
}

