//! Element ownership over the in-memory bus: a frame names its window only
//! when the host lists AT-SPI frames as windows.

use atspi::Role;
use senpi_desktop_core::ax::{AxBackend, AxOwner};

use crate::fake::{editor, node, FakeBus, FakeNode};
use crate::{AtSpiAx, WindowIds};

fn frames_backend(bus: FakeBus) -> AtSpiAx<FakeBus> {
    AtSpiAx {
        bus,
        window_ids: WindowIds::AtSpiFrames,
    }
}

#[test]
fn owner_is_the_listed_frame_when_windows_are_frames() {
    // Given: the editor's focused entry sits in frame 10.
    let mut ax = frames_backend(editor());
    let listed = ax.windows().unwrap().remove(0).id;
    // When
    let owner = ax.owner(&node(12)).unwrap();
    // Then: the owner is the id `windows()` lists for that frame.
    assert_eq!(owner, AxOwner::Window(listed));
}

#[test]
fn owner_is_unknown_when_window_ids_are_foreign() {
    // Given: an X11 host, whose window ids are XIDs.
    let mut ax = AtSpiAx::with_bus(editor());
    // When / Then: the frame is never offered as a window id.
    assert_eq!(ax.owner(&node(12)).unwrap(), AxOwner::Unknown);
}

#[test]
fn owner_is_unknown_outside_any_frame() {
    // Given: a panel directly under the application, not a frame.
    let mut bus = editor();
    bus.add(20, 1, FakeNode::new(Role::Panel, "tray"));
    bus.add(21, 20, FakeNode::new(Role::Button, "tray button"));
    let mut ax = frames_backend(bus);
    // When / Then
    assert_eq!(ax.owner(&node(21)).unwrap(), AxOwner::Unknown);
}
