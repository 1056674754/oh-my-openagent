//! The process macOS charges for this engine's TCC requests, not its parent.

use std::ffi::CStr;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;

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
    let output = match Command::new("/usr/bin/plutil")
        .args(["-extract", "CFBundleIdentifier", "raw", "-o", "-"])
        .arg(app.join("Contents/Info.plist"))
        .output()
    {
        Ok(output) if output.status.success() => output,
        Ok(_) | Err(_) => return None,
    };
    match String::from_utf8(output.stdout) {
        Ok(id) if !id.trim().is_empty() => Some(id.trim().to_owned()),
        Ok(_) | Err(_) => None,
    }
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
