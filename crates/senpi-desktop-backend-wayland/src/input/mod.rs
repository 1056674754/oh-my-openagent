//! libei input: the connection (`LIBEI_SOCKET` or a RemoteDesktop portal
//! session), device discovery, and the keyboard state the compositor
//! announces. Emission lives in `libei.rs`.

mod burst;
mod keymap;
mod libei;
mod lifecycle;
mod preflight;
pub mod xkb;

use reis::ei;
use reis::event::Device;
use reis::tokio::EiConvertEventStream;
use senpi_desktop_core::error::{CoreResult, DesktopError};
use tokio::runtime::Runtime;

use crate::portal::portal_runtime;
use crate::portal::remote_desktop::{self, Granted, PortalSession};
use xkb::KeyboardLayout;

const CONTEXT_NAME: &str = "senpi-desktop";
/// A `LIBEI_SOCKET` server makes no grant; discovery waits for both kinds.
const EVERY_DEVICE: Granted = Granted {
    pointer: true,
    keyboard: true,
};

struct EiDevice {
    device: Device,
    serial: u32,
    resumed: bool,
    layout: Option<KeyboardLayout>,
}

pub struct Libei {
    context: ei::Context,
    devices: Vec<EiDevice>,
    sequence: u32,
    runtime: &'static Runtime,
    events: Option<EiConvertEventStream>,
    /// evdev keys and buttons pressed and not yet released, for `release_all`.
    held_keys: Vec<u32>,
    held_buttons: Vec<u32>,
    /// Declared last: the portal session closes after the libei context.
    _portal: Option<PortalSession>,
}

// SAFETY: `EiConvertEventStream` is `!Send` only through its converter's
// `callbacks: HashMap<ei::Callback, Box<dyn FnOnce(u64)>>` (reis 0.5.0
// event.rs:89); every other field of it and of `Libei` is `Send`. That map
// can only be filled through `EiEventConverter::add_callback_handler`, which
// `EiConvertEventStream` never exposes, so it stays empty and no non-`Send`
// value ever exists inside a `Libei`. Ported from oh-my-pi libei.rs.
unsafe impl Send for Libei {}

impl Libei {
    /// Connects lazily on the first desktop input (oh-my-pi mod.rs:142-155):
    /// `LIBEI_SOCKET` when set, else a RemoteDesktop portal session.
    ///
    /// # Errors
    /// `InputFailed` when neither path exists or the handshake fails;
    /// `PermissionDenied` when the portal or its devices are refused.
    pub fn connect() -> CoreResult<Self> {
        let runtime = portal_runtime()?;
        let (context, portal, targets) = match ei::Context::connect_to_env() {
            Ok(Some(context)) => (context, None, EVERY_DEVICE),
            Ok(None) => {
                let (stream, session, granted) = remote_desktop::connect(runtime)?;
                let context = ei::Context::new(stream).map_err(|err| {
                    DesktopError::input_failed(format!("libei portal socket: {err}"))
                })?;
                (context, Some(session), granted)
            }
            Err(err) => {
                return Err(DesktopError::permission_denied(format!(
                    "LIBEI_SOCKET: {err}"
                )))
            }
        };
        let (_connection, events) = runtime
            .block_on(context.handshake_tokio(CONTEXT_NAME, ei::handshake::ContextType::Sender))
            .map_err(|err| DesktopError::input_failed(format!("libei handshake: {err}")))?;
        let mut libei = Self {
            context,
            devices: Vec::new(),
            sequence: 1,
            runtime,
            events: Some(events),
            held_keys: Vec::new(),
            held_buttons: Vec::new(),
            _portal: portal,
        };
        libei.discover_devices(targets)?;
        if libei.devices.is_empty() {
            return Err(DesktopError::permission_denied(
                "RemoteDesktop portal granted no libei keyboard or pointer devices",
            ));
        }
        Ok(libei)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_waits_for_every_granted_device() {
        let targets = EVERY_DEVICE;

        assert!(!lifecycle::discovery_complete(targets, false, true));
        assert!(lifecycle::discovery_complete(targets, true, true));
    }

    #[test]
    fn discovery_ignores_a_device_the_portal_did_not_grant() {
        let keyboard_only = Granted {
            pointer: false,
            keyboard: true,
        };
        assert!(lifecycle::discovery_complete(keyboard_only, false, true));
    }
}
