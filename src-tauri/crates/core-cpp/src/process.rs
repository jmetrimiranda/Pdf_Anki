//! Running a child process with a wall-clock limit, capped output and (Unix) its own process group, killed as a
//! whole when it times out or exits. No shell anywhere.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

/// How long to wait for the output readers after the process group is gone (a process that left the group could
/// keep the pipes open forever).
const READER_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Default)]
pub(crate) struct Captured {
    pub data: Vec<u8>,
    pub truncated: bool,
}

impl Captured {
    pub fn into_string(self) -> String {
        String::from_utf8_lossy(&self.data).into_owned()
    }
}

#[derive(Debug)]
pub(crate) struct Outcome {
    pub status: ExitStatus,
    pub stdout: Captured,
    pub stderr: Captured,
    pub elapsed: Duration,
    pub timed_out: bool,
}

impl Outcome {
    pub fn signal(&self) -> Option<String> {
        signal_of(&self.status)
    }
}

/// Spawns `cmd` (stdout and stderr piped and capped at `cap` bytes each, stdin from `stdin` or null), waits at most
/// `timeout`, then kills its whole process group.
pub(crate) fn supervise(
    cmd: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
) -> io::Result<Outcome> {
    supervise_in(cmd, stdin, timeout, cap, None)
}

/// [`supervise`], and then (Linux) also kills every process of this uid whose working directory or executable is
/// inside `job_dir` — the processes that left the group with `setsid`/`setpgid`. `job_dir` must be a directory only
/// the job uses (the fresh temp dir).
pub(crate) fn supervise_in(
    mut cmd: Command,
    stdin: Option<Vec<u8>>,
    timeout: Duration,
    cap: usize,
    job_dir: Option<&Path>,
) -> io::Result<Outcome> {
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let start = Instant::now();
    let mut child = cmd.spawn()?;

    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // Not joined: it ends when the program reads everything or its end of the pipe closes.
        thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
    }
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let stdout = spawn_reader(child.stdout.take(), cap, done_tx.clone());
    let stderr = spawn_reader(child.stderr.take(), cap, done_tx);

    let mut timed_out = false;
    let mut pause = Duration::from_millis(1);
    let elapsed = loop {
        if has_exited(&mut child)? {
            break start.elapsed();
        }
        let elapsed = start.elapsed();
        if elapsed >= timeout {
            timed_out = true;
            kill_group(&mut child);
            break elapsed;
        }
        thread::sleep(pause.min(timeout - elapsed));
        pause = (pause * 2).min(Duration::from_millis(20));
    };
    // Whatever the leader did, nothing it started may outlive the run.
    kill_group(&mut child);
    #[cfg(target_os = "linux")]
    if let Some(dir) = job_dir {
        kill_strays(dir);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = job_dir;
    let status = child.wait()?;

    let deadline = Instant::now() + READER_GRACE;
    for _ in 0..2 {
        let left = deadline.saturating_duration_since(Instant::now());
        if done_rx.recv_timeout(left).is_err() {
            break;
        }
    }
    Ok(Outcome {
        status,
        stdout: take(&stdout),
        stderr: take(&stderr),
        elapsed,
        timed_out,
    })
}

fn spawn_reader<R: Read + Send + 'static>(
    source: Option<R>,
    cap: usize,
    done: mpsc::Sender<()>,
) -> Arc<Mutex<Captured>> {
    let buffer = Arc::new(Mutex::new(Captured::default()));
    let Some(mut source) = source else {
        let _ = done.send(());
        return buffer;
    };
    let shared = Arc::clone(&buffer);
    thread::spawn(move || {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match source.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let Ok(mut captured) = shared.lock() else {
                        break;
                    };
                    let room = cap.saturating_sub(captured.data.len());
                    if n > room {
                        captured.truncated = true;
                    }
                    captured.data.extend_from_slice(&chunk[..n.min(room)]);
                    // Keep draining past the cap so the program never blocks on a full pipe.
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = done.send(());
    });
    buffer
}

fn take(buffer: &Mutex<Captured>) -> Captured {
    match buffer.lock() {
        Ok(mut captured) => std::mem::take(&mut *captured),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    }
}

/// Whether the leader has exited. On Linux the zombie is left in place (`WNOWAIT`) so its pid, which is the
/// process-group id, can't be reused before [`kill_group`].
#[cfg(target_os = "linux")]
fn has_exited(child: &mut Child) -> io::Result<bool> {
    use nix::sys::wait::{Id, WaitPidFlag, WaitStatus, waitid};
    let pid = group_pid(child);
    match waitid(
        Id::Pid(pid),
        WaitPidFlag::WEXITED | WaitPidFlag::WNOHANG | WaitPidFlag::WNOWAIT,
    ) {
        Ok(WaitStatus::StillAlive) => Ok(false),
        Ok(_) => Ok(true),
        Err(nix::errno::Errno::EINTR) => Ok(false),
        Err(err) => Err(io::Error::from(err)),
    }
}

#[cfg(not(target_os = "linux"))]
fn has_exited(child: &mut Child) -> io::Result<bool> {
    Ok(child.try_wait()?.is_some())
}

#[cfg(unix)]
fn group_pid(child: &Child) -> nix::unistd::Pid {
    nix::unistd::Pid::from_raw(i32::try_from(child.id()).unwrap_or(i32::MAX))
}

/// SIGKILL to the child's whole process group (Unix); `Child::kill` elsewhere.
#[cfg(unix)]
fn kill_group(child: &mut Child) {
    use nix::sys::signal::{Signal, killpg};
    // ESRCH: the group is already gone.
    let _ = killpg(group_pid(child), Signal::SIGKILL);
}

/// SIGKILL to every process (of this uid: the others' links can't be read) running in or from `dir`, repeated until
/// none is left (a stray may fork meanwhile). Best effort: a stray that `chdir`s out and `exec`s something else is
/// missed, but it still carries the CPU/memory/file limits.
#[cfg(target_os = "linux")]
fn kill_strays(dir: &Path) {
    use nix::sys::signal::{Signal, kill};
    let Ok(dir) = dir.canonicalize() else {
        return;
    };
    let me = std::process::id();
    for _ in 0..20 {
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return;
        };
        let mut found = false;
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|n| n.parse::<i32>().ok())
            else {
                continue;
            };
            if u32::try_from(pid).is_ok_and(|p| p == me) {
                continue;
            }
            let path = entry.path();
            let inside = ["cwd", "exe"].iter().any(|link| {
                std::fs::read_link(path.join(link)).is_ok_and(|target| target.starts_with(&dir))
            });
            if inside {
                let _ = kill(nix::unistd::Pid::from_raw(pid), Signal::SIGKILL);
                found = true;
            }
        }
        if !found {
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(not(unix))]
fn kill_group(child: &mut Child) {
    let _ = child.kill();
}

#[cfg(unix)]
pub(crate) fn signal_of(status: &ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(signal_name)
}

#[cfg(not(unix))]
pub(crate) fn signal_of(_status: &ExitStatus) -> Option<String> {
    None
}

/// `SIGKILL`, `SIGXCPU`… (`SIG<n>` for numbers without a name).
#[cfg(unix)]
pub(crate) fn signal_name(signal: i32) -> String {
    nix::sys::signal::Signal::try_from(signal)
        .map(|s| s.as_str().to_owned())
        .unwrap_or_else(|_| format!("SIG{signal}"))
}

/// The executable `name` (`name.exe` on Windows) in a PATH directory.
pub(crate) fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    std::env::split_paths(&path)
        .map(|dir| dir.join(&file))
        .find(|candidate| is_executable(candidate))
}

pub(crate) fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// util-linux `prlimit` (Linux), looked up once; warns once when it is missing.
pub(crate) fn prlimit() -> Option<&'static Path> {
    static PRLIMIT: OnceLock<Option<PathBuf>> = OnceLock::new();
    PRLIMIT
        .get_or_init(|| {
            let found = if cfg!(target_os = "linux") { find_on_path("prlimit") } else { None };
            if found.is_none() {
                tracing::warn!(
                    "prlimit not found: C++ programs run with the time limit and process-group kill only, without \
                     CPU/memory/file-size/process limits"
                );
            }
            found
        })
        .as_deref()
}

/// Number of tasks (threads included, as RLIMIT_NPROC counts them) of this process's real uid visible in `/proc`.
#[cfg(target_os = "linux")]
pub(crate) fn tasks_of_current_uid() -> Option<u64> {
    let me = real_uid(&std::fs::read_to_string("/proc/self/status").ok()?)?;
    let mut total = 0u64;
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else {
            continue;
        };
        if real_uid(&status) == Some(me) {
            total += status_field(&status, "Threads:")
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
        }
    }
    Some(total)
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn tasks_of_current_uid() -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn status_field<'a>(status: &'a str, key: &str) -> Option<&'a str> {
    status
        .lines()
        .find_map(|line| line.strip_prefix(key))
        .map(str::trim)
}

#[cfg(target_os = "linux")]
fn real_uid(status: &str) -> Option<u32> {
    status_field(status, "Uid:")?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn counts_own_tasks() {
        let n = tasks_of_current_uid().unwrap();
        assert!(n >= 1);
    }

    #[test]
    fn captures_and_caps() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "head -c 5000 /dev/zero; echo err >&2"]);
        let out = supervise(cmd, None, Duration::from_secs(5), 1000).unwrap();
        assert_eq!(out.stdout.data.len(), 1000);
        assert!(out.stdout.truncated);
        assert_eq!(out.stderr.into_string(), "err\n");
        assert!(out.status.success());
    }

    /// Pids of this uid whose working directory is inside `dir`.
    fn running_in(dir: &Path) -> Vec<String> {
        let dir = dir.canonicalize().unwrap();
        std::fs::read_dir("/proc")
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .is_some_and(|n| n.parse::<u32>().is_ok())
            })
            .filter(|e| std::fs::read_link(e.path().join("cwd")).is_ok_and(|t| t.starts_with(&dir)))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn setsid_escape_is_killed() {
        let dir = tempfile::tempdir().unwrap();
        let mut cmd = Command::new("sh");
        // The stray leaves the process group and closes the pipes, so neither killpg nor the readers wait for it.
        cmd.args([
            "-c",
            "setsid sleep 60 </dev/null >/dev/null 2>&1 & echo started",
        ])
        .current_dir(dir.path());
        let out = supervise_in(cmd, None, Duration::from_secs(5), 100, Some(dir.path())).unwrap();
        assert_eq!(out.stdout.into_string(), "started\n");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !running_in(dir.path()).is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(running_in(dir.path()), Vec::<String>::new());
    }

    #[test]
    fn stdin_and_timeout() {
        let mut cmd = Command::new("cat");
        cmd.arg("-");
        let out = supervise(cmd, Some(b"abc".to_vec()), Duration::from_secs(5), 100).unwrap();
        assert_eq!(out.stdout.into_string(), "abc");
        let mut cmd = Command::new("sleep");
        cmd.arg("30");
        let out = supervise(cmd, None, Duration::from_millis(200), 100).unwrap();
        assert!(out.timed_out);
        assert_eq!(out.signal().as_deref(), Some("SIGKILL"));
        assert!(out.elapsed < Duration::from_secs(2));
    }
}
