//! Pointer input on the system input queue (`SendInput`), shared by the
//! desktop and the foreground routes. enigo's absolute move normalizes
//! against the primary monitor only (`SM_CXSCREEN`), so every move goes
//! through the virtual-desktop `SendInput` path instead.

use senpi_desktop_core::backend::{MouseButton, PointerEvent};
use senpi_desktop_core::error::{CoreResult, DesktopError};

use super::dispatch::{to_physical, Via, Win32Input};
use super::held::{HeldButton, Route};
use super::keys::modifier_virtual_keys;
use super::messages::{scroll_steps, WHEEL_DELTA};
use super::native::Window;
use super::system;

/// #9095 diagnostic (temporary): which settle step follows a move.
fn variant() -> String {
    std::env::var("OMO_9095_VARIANT").unwrap_or_default()
}

/// #9095 diagnostic (temporary): moves the cursor the way the variant says,
/// then settles it the way the variant says.
fn diag_move(point: (i32, i32), target: Option<Window>) -> CoreResult<()> {
    match variant().as_str() {
        "setcursorpos" => super::native::set_cursor(point.0, point.1)?,
        _ => system::move_to(point, target)?,
    }
    super::diag_timeline::mark("moved", Some(point));
    match variant().as_str() {
        "barrier" => {
            if let Some(window) = target {
                super::barrier::delivered(window)?;
            }
        }
        "sleep50" => std::thread::sleep(std::time::Duration::from_millis(50)),
        "sleep200" => std::thread::sleep(std::time::Duration::from_millis(200)),
        _ => {}
    }
    super::diag_timeline::mark(&format!("settled variant={}", variant()), Some(point));
    Ok(())
}

impl Win32Input {
    pub(super) fn system_pointer(
        &mut self,
        event: &PointerEvent,
        target: Option<Window>,
    ) -> CoreResult<()> {
        match event {
            PointerEvent::Click {
                x,
                y,
                button,
                count,
                modifiers,
            } => {
                diag_move(to_physical(*x, *y)?, target)?;
                self.holding(Via::SendInput(target), &modifier_virtual_keys(*modifiers), |this| {
                    for _ in 0..*count {
                        this.system_button(*button, true, target)?;
                        this.system_button(*button, false, target)?;
                    }
                    Ok(())
                })
            }
            PointerEvent::Move { x, y } => diag_move(to_physical(*x, *y)?, target),
            PointerEvent::Drag {
                path,
                button,
                modifiers,
            } => {
                let Some(&(x, y)) = path.first() else {
                    return Err(DesktopError::input_failed("drag path is empty"));
                };
                diag_move(to_physical(x, y)?, target)?;
                self.holding(Via::SendInput(target), &modifier_virtual_keys(*modifiers), |this| {
                    this.system_button(*button, true, target)?;
                    let movement = path
                        .iter()
                        .skip(1)
                        .try_for_each(|&(x, y)| diag_move(to_physical(x, y)?, target));
                    let release = this.system_button(*button, false, target);
                    movement.and(release)
                })
            }
            PointerEvent::Scroll { x, y, dx, dy } if variant() == "one-call" && *dx == 0.0 => {
                let vertical = scroll_steps(*dy).saturating_mul(-WHEEL_DELTA);
                system::move_and_wheel(to_physical(*x, *y)?, vertical, target)?;
                super::diag_timeline::mark("move-and-wheel", to_physical(*x, *y).ok());
                Ok(())
            }
            PointerEvent::Scroll { x, y, dx, dy } => {
                diag_move(to_physical(*x, *y)?, target)?;
                let horizontal = scroll_steps(*dx).saturating_mul(WHEEL_DELTA);
                let vertical = scroll_steps(*dy).saturating_mul(-WHEEL_DELTA);
                if horizontal != 0 {
                    system::wheel(true, horizontal, target)?;
                }
                if vertical != 0 {
                    system::wheel(false, vertical, target)?;
                    super::diag_timeline::mark("wheel", to_physical(*x, *y).ok());
                }
                Ok(())
            }
        }
    }

    /// One button transition, recorded in the ledger once delivered.
    fn system_button(
        &mut self,
        button: MouseButton,
        down: bool,
        target: Option<Window>,
    ) -> CoreResult<()> {
        system::button(button, down, target)?;
        super::diag_timeline::mark(if down { "button-down" } else { "button-up" }, None);
        if down {
            self.held.button_down(HeldButton {
                route: Route::System,
                button,
                at: 0,
            });
        } else {
            self.held.button_up(Route::System, button);
        }
        Ok(())
    }
}
