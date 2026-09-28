use arboard::Clipboard as SystemClipboard;
use senpi_desktop_core::error::{CoreResult, DesktopError};

#[derive(Default)]
pub(crate) struct Clipboard {
    system: Option<CoreResult<SystemClipboard>>,
}

impl Clipboard {
    pub(crate) fn read(&mut self) -> CoreResult<String> {
        self.system()?.get_text().map_err(|error| {
            DesktopError::internal(format!("reading the macOS clipboard failed: {error}"))
        })
    }

    pub(crate) fn write(&mut self, text: &str) -> CoreResult<()> {
        self.system()?.set_text(text).map_err(|error| {
            DesktopError::internal(format!("writing the macOS clipboard failed: {error}"))
        })
    }

    fn system(&mut self) -> CoreResult<&mut SystemClipboard> {
        let system = self.system.get_or_insert_with(|| {
            SystemClipboard::new().map_err(|error| {
                DesktopError::internal(format!("opening the macOS clipboard failed: {error}"))
            })
        });
        match system {
            Ok(clipboard) => Ok(clipboard),
            Err(error) => Err(error.clone()),
        }
    }
}
