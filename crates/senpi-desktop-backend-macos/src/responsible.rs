//! The process macOS charges for this engine's TCC requests, not its parent.

use std::ffi::CStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use objc2_core_foundation::{CFBundle, CFString, CFURL, CFURLPathStyle};

/// Larger Info.plist files are not read: the bundle id is diagnostic metadata.
const MAX_INFO_PLIST_BYTES: u64 = 1024 * 1024;
/// Reverse-DNS bundle identifiers are short; anything longer is not reported.
const MAX_BUNDLE_ID_CHARS: usize = 255;

pub(crate) struct ResponsibleProcess {
    pub(crate) pid: libc::pid_t,
    pub(crate) executable: PathBuf,
    pub(crate) bundle_id: Option<String>,
}

pub(crate) fn suffix_with(lookup: impl FnOnce() -> Option<ResponsibleProcess>) -> String {
    match lookup() {
        Some(identity) => {
            let bundle = identity.bundle_id.map_or_else(String::new, |id| format!(" bundle={id}"));
            format!("responsible={}{bundle}, pid={}", identity.executable.display(), identity.pid)
        }
        None => {
            let executable = std::env::current_exe()
                .map_or_else(|_| "<unavailable>".to_owned(), |path| path.display().to_string());
            format!("unresolved (engine executable={executable})")
        }
    }
}

unsafe extern "C" {
    fn responsibility_get_pid_responsible_for_pid(pid: libc::pid_t) -> libc::pid_t;
}

fn responsible_pid(pid: libc::pid_t) -> Option<libc::pid_t> {
    // SAFETY: the responsibility API takes and returns scalar pid_t values;
    // no pointers or retained resources cross this boundary.
    let responsible = unsafe { responsibility_get_pid_responsible_for_pid(pid) };
    (responsible > 0).then_some(responsible)
}

fn executable_path(pid: libc::pid_t) -> Option<PathBuf> {
    let mut buffer = [0_u8; 4096];
    // SAFETY: proc_pidpath writes at most the supplied buffer size. The buffer
    // is initialized, writable, and lives until the call returns.
    let length = unsafe {
        libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), 4096)
    };
    if length <= 0 {
        return None;
    }
    let path = match CStr::from_bytes_until_nul(&buffer) {
        Ok(path) => path,
        Err(_) => return None,
    };
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(path.to_bytes())))
}

fn bundle_id(executable: &Path) -> Option<String> {
    let app = executable.ancestors().find(|path| path.extension().is_some_and(|ext| ext == "app"))?;
    let plist_len = std::fs::metadata(app.join("Contents/Info.plist")).ok()?.len();
    if plist_len > MAX_INFO_PLIST_BYTES {
        return None;
    }
    let path = CFString::from_str(app.to_str()?);
    let url = CFURL::with_file_system_path(None, Some(&path), CFURLPathStyle::CFURLPOSIXPathStyle, true)?;
    // CFBundleGetIdentifier only returns a string-typed CFBundleIdentifier.
    let id = CFBundle::new(None, Some(&url))?.identifier()?.to_string();
    valid_bundle_id(&id).then_some(id)
}

fn valid_bundle_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_BUNDLE_ID_CHARS
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

pub(crate) fn current() -> Option<ResponsibleProcess> {
    let pid = match libc::pid_t::try_from(std::process::id()) {
        Ok(pid) => pid,
        Err(_) => return None,
    };
    resolve_with(pid, responsible_pid, executable_path, bundle_id)
}

fn resolve_with(
    pid: libc::pid_t,
    responsibility: impl FnOnce(libc::pid_t) -> Option<libc::pid_t>,
    path: impl FnOnce(libc::pid_t) -> Option<PathBuf>,
    bundle: impl FnOnce(&Path) -> Option<String>,
) -> Option<ResponsibleProcess> {
    let pid = responsibility(pid)?;
    let executable = path(pid)?;
    let bundle_id = bundle(&executable);
    Some(ResponsibleProcess { pid, executable, bundle_id })
}

#[cfg(test)]
#[path = "responsible/tests.rs"]
mod tests;
