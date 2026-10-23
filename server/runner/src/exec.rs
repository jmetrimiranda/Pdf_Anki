//! Compiling and running one job under `prlimit` + `timeout`, in its own directory and process group, as the job
//! user (`RUNNER_JOB_USER`, a uid distinct from the server's) with a minimal environment. After every step, a reaper
//! running as the job user kills every process of that uid (`kill(-1)`: `setsid` can't escape it); after every job it
//! also wipes the job user's files from `/work`, `/tmp` and `/dev/shm`.

use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::CHECK_HPP;
use crate::api::{CompileOut, Executor, Job, RunOut, RunResponse};
use crate::validate::CHECK_HEADER;

/// Each captured stream keeps at most this many bytes.
pub const OUTPUT_CAP_BYTES: usize = 256 * 1024;

/// Compiler limits: CPU 10 s (soft:hard), 1 GiB address space, 10 MB files (+ `--nproc`); `timeout` 15 s.
const COMPILE_LIMITS: [&str; 3] = ["--cpu=10:11", "--as=1073741824", "--fsize=10485760"];
const COMPILE_WALL_SECONDS: u64 = 15;
/// Program limits (spec 11.5): CPU 5 s (SIGXCPU; hard 6 s), 512 MB, 10 MB files (+ `--nproc`).
const RUN_LIMITS: [&str; 3] = ["--cpu=5:6", "--as=536870912", "--fsize=10485760"];
/// Processes (tasks) of the job user (spec 11.5: 64). Without a job user (unit tests), the runner's uid, the runner
/// itself included.
pub const DEFAULT_NPROC: u64 = 64;
const COMPILER_FLAGS: [&str; 4] = ["-std=c++20", "-O0", "-Wall", "-Wextra"];
/// After the leader exits, how long to wait for the readers (a process that escaped the group could hold the pipes).
const READER_GRACE: Duration = Duration::from_secs(2);
/// The only environment a compiler or program sees (never the runner's: it holds `RUNNER_TOKEN`).
const JOB_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/// Shared writable places a job can leave files in (besides the work root): wiped after every job.
pub const SHARED_TMP_DIRS: [&str; 2] = ["/tmp", "/dev/shm"];
/// The reaper is quick (a few `kill` calls and a directory walk); this is only a backstop.
const REAPER_TIMEOUT: Duration = Duration::from_secs(10);

/// The uid:gid jobs run as. Must differ from the server's, so a job can neither signal the server nor read its
/// `/proc/<pid>/environ`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobUser {
    pub uid: u32,
    pub gid: u32,
}

impl JobUser {
    /// `"10002:10002"` (or `"10002"`, gid = uid). Root is refused.
    pub fn parse(value: &str) -> Option<Self> {
        let value = value.trim();
        let (uid, gid) = match value.split_once(':') {
            Some((uid, gid)) => (uid.parse().ok()?, gid.parse().ok()?),
            None => {
                let uid = value.parse().ok()?;
                (uid, uid)
            }
        };
        (uid != 0 && gid != 0).then_some(Self { uid, gid })
    }

    /// `setpriv` switches to the job user (real, effective and saved ids) and drops every inheritable and ambient
    /// capability, so whatever it executes has none. The server needs CAP_SETUID/CAP_SETGID (ambient) for this.
    fn setpriv(self) -> Command {
        let mut cmd = Command::new("setpriv");
        cmd.arg(format!("--reuid={}", self.uid))
            .arg(format!("--regid={}", self.gid))
            .args([
                "--clear-groups",
                "--inh-caps=-all",
                "--ambient-caps=-all",
                "--no-new-privs",
                "--",
            ]);
        cmd
    }
}

/// Kills every process of the job user and wipes its files: `runner --reap <uid> [dir…]` run as the job user.
#[derive(Debug, Clone)]
pub struct Reaper {
    pub user: JobUser,
    /// The runner binary itself.
    pub exe: PathBuf,
}

impl Reaper {
    /// Kills every process of the job user, then (if `dirs` is not empty) removes the job user's files in them.
    pub async fn reap(&self, dirs: &[&Path]) -> Result<(), String> {
        let mut cmd = self.user.setpriv();
        cmd.arg(&self.exe)
            .arg("--reap")
            .arg(self.user.uid.to_string())
            .args(dirs)
            .env_clear()
            .env("PATH", JOB_PATH)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let out = tokio::time::timeout(REAPER_TIMEOUT, cmd.output())
            .await
            .map_err(|_| "reaper timed out".to_owned())?
            .map_err(|e| format!("reaper: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "reaper failed ({}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
}

/// The body of `runner --reap <uid> [dir…]`. Refuses to do anything unless it runs as exactly `uid` (never root):
/// `kill(-1)` signals every process this uid may signal.
pub fn reap_main(args: &[String]) -> Result<(), String> {
    let uid: u32 = args
        .first()
        .and_then(|u| u.parse().ok())
        .ok_or("usage: runner --reap <uid> [dir…]")?;
    let (real, effective) = (
        nix::unistd::getuid().as_raw(),
        nix::unistd::geteuid().as_raw(),
    );
    if uid == 0 || real != uid || effective != uid {
        return Err(format!(
            "refusing to reap: running as {real}/{effective}, expected {uid}"
        ));
    }
    kill_all_of_own_uid(uid);
    for dir in &args[1..] {
        wipe_owned(Path::new(dir), uid);
    }
    // Anything forked while the files were going.
    kill_all_of_own_uid(uid);
    Ok(())
}

/// `kill(-1, SIGKILL)` until no live process of this uid is left but the caller. The kernel walks the task list
/// under a lock fork needs, so a fork bomb can't outrun one call; the loop covers the rest. (`kill(-1)` itself can't
/// tell: it reports success as long as any process other than init and the caller exists, signalled or not.)
fn kill_all_of_own_uid(uid: u32) {
    use nix::sys::signal::{Signal, kill};
    for _ in 0..100 {
        let _ = kill(nix::unistd::Pid::from_raw(-1), Signal::SIGKILL);
        if !others_alive(uid) {
            return;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// Whether `/proc` shows a process of `uid` other than the caller that is not a zombie.
fn others_alive(uid: u32) -> bool {
    let me = std::process::id().to_string();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return false;
        };
        if name == me || name.is_empty() || !name.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else {
            return false;
        };
        let field = |key: &str| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(key))
                .map(str::trim)
        };
        let owned = field("Uid:")
            .and_then(|v| v.split_whitespace().next())
            .and_then(|v| v.parse::<u32>().ok())
            == Some(uid);
        owned
            && !field("State:")
                .is_some_and(|state| state.starts_with('Z') || state.starts_with('X'))
    })
}

/// Removes everything owned by `uid` in `root` and in the directories directly under it that belong to someone else
/// (the job directories, created by the server). Never follows symlinks; errors are skipped.
pub fn wipe_owned(root: &Path, uid: u32) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.uid() == uid {
            remove_tree(path);
        } else if meta.is_dir() {
            let Ok(inner) = std::fs::read_dir(&path) else {
                continue;
            };
            for entry in inner.flatten() {
                if std::fs::symlink_metadata(entry.path()).is_ok_and(|m| m.uid() == uid) {
                    remove_tree(entry.path());
                }
            }
        }
    }
}

/// Removes `path` (a tree owned by the caller), restoring owner permissions on directories first. Iterative: a job
/// can nest directories deeper than any stack.
fn remove_tree(path: PathBuf) {
    let mut stack = vec![(path, false)];
    while let Some((path, emptied)) = stack.pop() {
        if emptied {
            let _ = std::fs::remove_dir(&path);
            continue;
        }
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_dir() => {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
                stack.push((path.clone(), true));
                if let Ok(entries) = std::fs::read_dir(&path) {
                    stack.extend(entries.flatten().map(|e| (e.path(), false)));
                }
            }
            Ok(_) => {
                let _ = std::fs::remove_file(&path);
            }
            Err(_) => {}
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExecConfig {
    /// Parent of the job directories (`/work`, a tmpfs in the container).
    pub work_root: PathBuf,
    /// `g++` unless `RUNNER_CXX` says otherwise.
    pub compiler: String,
    /// First line of `<compiler> --version`, reported in every response.
    pub compiler_version: Option<String>,
    /// `prlimit --nproc` ([`DEFAULT_NPROC`]; `RUNNER_NPROC`). RLIMIT_NPROC counts every task of the uid, so the
    /// unit tests, which run as the developer's uid, raise it.
    pub nproc: u64,
    /// Jobs run as this user and are reaped after every step. `None` (unit tests, development): the runner's own uid
    /// and only the process-group kill.
    pub reaper: Option<Reaper>,
}

impl ExecConfig {
    pub async fn detect(
        work_root: PathBuf,
        compiler: String,
        nproc: u64,
        reaper: Option<Reaper>,
    ) -> Self {
        let compiler_version = Command::new(&compiler)
            .arg("--version")
            .env_clear()
            .env("PATH", JOB_PATH)
            .stdin(Stdio::null())
            .output()
            .await
            .ok()
            .and_then(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .lines()
                    .next()
                    .map(|l| l.trim().to_owned())
            })
            .filter(|line| !line.is_empty());
        Self {
            work_root,
            compiler,
            compiler_version,
            nproc,
            reaper,
        }
    }

    /// `prlimit …` for a compiler or program: as the job user when there is one, never with the runner's
    /// environment.
    fn job_command(&self, home: &Path) -> Command {
        let mut cmd = match &self.reaper {
            Some(reaper) => {
                let mut cmd = reaper.user.setpriv();
                cmd.arg("prlimit");
                cmd
            }
            None => Command::new("prlimit"),
        };
        cmd.env_clear()
            .env("PATH", JOB_PATH)
            .env("LANG", "C.UTF-8")
            .env("HOME", home)
            // The compiler's and the program's temporary files stay in the job directory (removed with it), never
            // in the shared /tmp, which a previous job could have filled.
            .env("TMPDIR", home);
        cmd
    }

    /// The [`Executor`] for the API.
    pub fn executor(self) -> Executor {
        let config = Arc::new(self);
        Arc::new(move |job| {
            let config = Arc::clone(&config);
            Box::pin(async move { run_job(&config, job).await })
        })
    }
}

/// Runs `job` in a fresh directory under `work_root` and removes it afterwards.
pub async fn run_job(config: &ExecConfig, job: Job) -> Result<RunResponse, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = config.work_root.join(format!(
        "job-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    if config.reaper.is_some() {
        // The job user writes `prog` (and whatever the program writes) here; the reaper removes it all.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777))
            .map_err(|e| format!("chmod {}: {e}", dir.display()))?;
    }
    let mut result = run_in(config, &job, &dir).await;
    if let Some(reaper) = &config.reaper {
        let mut dirs: Vec<&Path> = vec![&config.work_root];
        dirs.extend(SHARED_TMP_DIRS.iter().map(Path::new));
        if let Err(err) = reaper.reap(&dirs).await {
            eprintln!("error: {err}");
            result = Err(err);
        }
    }
    if let Err(err) = std::fs::remove_dir_all(&dir) {
        eprintln!("warning: could not remove {}: {err}", dir.display());
    }
    result
}

async fn run_in(
    config: &ExecConfig,
    job: &Job,
    dir: &std::path::Path,
) -> Result<RunResponse, String> {
    for (name, content) in &job.files {
        std::fs::write(dir.join(name), content).map_err(|e| format!("write {name}: {e}"))?;
    }
    std::fs::write(dir.join(CHECK_HEADER), CHECK_HPP)
        .map_err(|e| format!("write {CHECK_HEADER}: {e}"))?;
    let nproc = format!("--nproc={}", config.nproc);

    let mut compile = config.job_command(dir);
    compile
        .args(COMPILE_LIMITS)
        .arg(&nproc)
        .arg("--")
        .args(["timeout", "-s", "KILL", &COMPILE_WALL_SECONDS.to_string()])
        .arg(&config.compiler)
        .args(COMPILER_FLAGS)
        .args(["-o", "prog"])
        .args(&job.sources)
        .current_dir(dir);
    let out = supervise(
        compile,
        None,
        Duration::from_secs(COMPILE_WALL_SECONDS + 1),
        config.reaper.as_ref(),
    )
    .await
    .map_err(|e| format!("compiler: {e}"))?;
    let mut stderr = out.stderr.into_string();
    let ok = out.status.success() && !out.timed_out;
    if !ok && (out.timed_out || out.status.code() == Some(137)) {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str(&format!(
            "compilation time limit exceeded ({COMPILE_WALL_SECONDS} s)"
        ));
    }
    let compile = CompileOut {
        ok,
        stderr,
        time_ms: millis(out.elapsed),
    };
    if !ok {
        return Ok(RunResponse {
            compile,
            run: None,
            compiler: config.compiler_version.clone(),
        });
    }

    // Our own timer is the limit; `timeout` is the backstop half a second later.
    let limit = Duration::from_millis(job.timeout_ms);
    let backstop_ms = job.timeout_ms + 500;
    let backstop = format!("{}.{:03}", backstop_ms / 1000, backstop_ms % 1000);
    let mut run = config.job_command(dir);
    run.args(RUN_LIMITS)
        .arg(&nproc)
        .arg("--")
        .args(["timeout", "-s", "KILL", &backstop, "./prog"])
        .current_dir(dir);
    let out = supervise(
        run,
        Some(job.stdin.as_bytes().to_vec()),
        limit,
        config.reaper.as_ref(),
    )
    .await
    .map_err(|e| format!("program: {e}"))?;
    let signal = signal_of(&out.status);
    // SIGXCPU: CPU limit; SIGKILL: our timer, `timeout` or the hard CPU limit; 137: `timeout` killed it.
    let timed_out = out.timed_out
        || matches!(signal.as_deref(), Some("SIGXCPU" | "SIGKILL"))
        || (out.status.code() == Some(137) && out.elapsed >= limit);
    let run = RunOut {
        exit_code: out.status.code(),
        signal,
        time_ms: millis(out.elapsed),
        timed_out,
        truncated: out.stdout.truncated || out.stderr.truncated,
        stdout: out.stdout.into_string(),
        stderr: out.stderr.into_string(),
    };
    Ok(RunResponse {
        compile,
        run: Some(run),
        compiler: config.compiler_version.clone(),
    })
}

#[derive(Debug, Default)]
struct Captured {
    data: Vec<u8>,
    truncated: bool,
}

impl Captured {
    fn into_string(self) -> String {
        String::from_utf8_lossy(&self.data).into_owned()
    }
}

struct Outcome {
    status: ExitStatus,
    stdout: Captured,
    stderr: Captured,
    elapsed: Duration,
    timed_out: bool,
}

/// Spawns `cmd` in its own process group with piped, capped output; kills the group at `limit` and always once the
/// leader is gone, then (with a job user) every process of the job user, so nothing outlives the step — not even a
/// process that left the group with `setsid`.
async fn supervise(
    mut cmd: Command,
    stdin: Option<Vec<u8>>,
    limit: Duration,
    reaper: Option<&Reaper>,
) -> std::io::Result<Outcome> {
    cmd.process_group(0)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let start = Instant::now();
    let mut child = cmd.spawn()?;
    let pgid = child.id().and_then(|id| i32::try_from(id).ok());
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        tokio::spawn(async move {
            let _ = pipe.write_all(&input).await;
        });
    }
    let stdout = Arc::new(Mutex::new(Captured::default()));
    let stderr = Arc::new(Mutex::new(Captured::default()));
    let readers = [
        child
            .stdout
            .take()
            .map(|s| tokio::spawn(read_capped(s, Arc::clone(&stdout)))),
        child
            .stderr
            .take()
            .map(|s| tokio::spawn(read_capped(s, Arc::clone(&stderr)))),
    ];

    let (status, timed_out) = match tokio::time::timeout(limit, child.wait()).await {
        Ok(status) => (status?, false),
        Err(_) => {
            kill_group(pgid);
            (child.wait().await?, true)
        }
    };
    let elapsed = start.elapsed();
    kill_group(pgid);
    if let Some(reaper) = reaper {
        reaper.reap(&[]).await.map_err(std::io::Error::other)?;
    }
    for reader in readers.into_iter().flatten() {
        let _ = tokio::time::timeout(READER_GRACE, reader).await;
    }
    Ok(Outcome {
        status,
        stdout: take(&stdout),
        stderr: take(&stderr),
        elapsed,
        timed_out,
    })
}

async fn read_capped<R: AsyncRead + Unpin>(mut source: R, into: Arc<Mutex<Captured>>) {
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        match source.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let Ok(mut captured) = into.lock() else { break };
                let room = OUTPUT_CAP_BYTES.saturating_sub(captured.data.len());
                if n > room {
                    captured.truncated = true;
                }
                captured.data.extend_from_slice(&chunk[..n.min(room)]);
            }
        }
    }
}

fn take(buffer: &Mutex<Captured>) -> Captured {
    match buffer.lock() {
        Ok(mut captured) => std::mem::take(&mut *captured),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    }
}

fn kill_group(pgid: Option<i32>) {
    if let Some(pgid) = pgid {
        // ESRCH: already gone.
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pgid),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
}

fn signal_of(status: &ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt;
    status.signal().map(|signal| {
        nix::sys::signal::Signal::try_from(signal)
            .map(|s| s.as_str().to_owned())
            .unwrap_or_else(|_| format!("SIG{signal}"))
    })
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    //! Real compiler runs (g++, prlimit and timeout are in the devcontainer and in the image).
    use super::*;
    use std::collections::BTreeMap;

    async fn job(source: &str, stdin: &str, timeout_ms: u64) -> (RunResponse, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let config = ExecConfig::detect(root.path().to_owned(), "g++".into(), 1 << 20, None).await;
        let files: BTreeMap<String, String> = [("main.cpp".to_owned(), source.to_owned())].into();
        let job = Job {
            sources: vec!["main.cpp".into()],
            files,
            stdin: stdin.into(),
            timeout_ms,
        };
        (run_job(&config, job).await.unwrap(), root)
    }

    #[tokio::test]
    async fn tmpdir_is_the_job_directory() {
        // The compiler and the program get the job directory as TMPDIR (removed with it), never the shared /tmp.
        let (r, _root) = job(
            "#include <cstdio>\n#include <cstdlib>\n#include <cstring>\n#include <unistd.h>\nint main() { char cwd[4096]; const char* t = std::getenv(\"TMPDIR\"); std::puts(t && getcwd(cwd, sizeof cwd) && !std::strcmp(t, cwd) ? \"job\" : \"other\"); }\n",
            "",
            10_000,
        )
        .await;
        assert!(r.compile.ok, "{}", r.compile.stderr);
        assert_eq!(r.run.unwrap().stdout, "job\n");
    }

    #[tokio::test]
    async fn testes_and_saida() {
        let (r, root) = job(
            "#include \"check.hpp\"\n#include <iostream>\nint main() { std::string s; std::cin >> s; std::cout << s << '\\n'; CHECK(1 + 1 == 2); CHECK(2 * 2 == 5); }\n",
            "eco",
            10_000,
        )
        .await;
        assert!(r.compile.ok, "{}", r.compile.stderr);
        assert!(r.compiler.as_deref().unwrap_or_default().contains("g++"));
        let run = r.run.unwrap();
        assert_eq!(
            run.stdout,
            "eco\nPASS 1 + 1 == 2\nFAIL 2 * 2 == 5 (main.cpp:3)\n"
        );
        assert_eq!(run.exit_code, Some(1));
        assert!(!run.timed_out);
        // The job directory is gone.
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn program_never_sees_the_runner_environment() {
        // The test process's own environment (CARGO_*, RUST_*, …) stands in for the runner's RUNNER_TOKEN.
        let (r, _root) = job(
            "#include <cstdio>\nextern char** environ;\nint main() { for (char** e = environ; *e; ++e) std::puts(*e); }\n",
            "",
            5_000,
        )
        .await;
        let run = r.run.unwrap();
        let mut names: Vec<&str> = run
            .stdout
            .lines()
            .filter_map(|l| l.split_once('=').map(|(k, _)| k))
            .collect();
        names.sort_unstable();
        assert_eq!(names, ["HOME", "LANG", "PATH", "TMPDIR"], "{}", run.stdout);
    }

    #[test]
    fn job_user_parsing() {
        assert_eq!(
            JobUser::parse("10002:10003"),
            Some(JobUser {
                uid: 10002,
                gid: 10003
            })
        );
        assert_eq!(
            JobUser::parse(" 10002 "),
            Some(JobUser {
                uid: 10002,
                gid: 10002
            })
        );
        for bad in ["", "0", "0:0", "10002:0", "x", "10002:", "-1"] {
            assert_eq!(JobUser::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn reap_refuses_a_foreign_uid() {
        // Never reaches kill(-1): the test process does not run as uid 4242 (nor as root, with uid 0).
        assert!(reap_main(&["4242".into()]).is_err());
        assert!(reap_main(&["0".into()]).is_err());
        assert!(reap_main(&[]).is_err());
    }

    #[test]
    fn others_alive_sees_a_child_of_the_same_uid() {
        let me = std::fs::metadata("/proc/self").unwrap().uid();
        let mut child = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        assert!(others_alive(me));
        child.kill().unwrap();
        child.wait().unwrap();
        // A uid with no process at all.
        assert!(!others_alive(4_000_000));
    }

    #[test]
    fn wipe_removes_only_own_files() {
        let root = tempfile::tempdir().unwrap();
        let me = std::fs::metadata(root.path()).unwrap().uid();
        // Owned: a file, a deep tree with a read-only, non-searchable directory, a symlink (removed, not followed).
        std::fs::write(root.path().join("marker"), "x").unwrap();
        let deep = root.path().join("a/b/c");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("f"), "x").unwrap();
        std::fs::set_permissions(
            root.path().join("a/b"),
            std::fs::Permissions::from_mode(0o000),
        )
        .unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("link")).unwrap();
        wipe_owned(root.path(), me);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        assert!(outside.path().join("keep").exists());
        // A different uid owns nothing here: nothing goes.
        std::fs::write(root.path().join("marker"), "x").unwrap();
        wipe_owned(root.path(), me + 1);
        assert!(root.path().join("marker").exists());
    }

    #[tokio::test]
    async fn compile_error() {
        let (r, _root) = job("int main() { return 0 }", "", 10_000).await;
        assert!(!r.compile.ok);
        assert!(r.compile.stderr.contains("error"));
        assert!(r.run.is_none());
    }

    #[tokio::test]
    async fn timeout_and_output_cap() {
        let (r, _root) = job("int main() { for (;;) {} }", "", 700).await;
        let run = r.run.unwrap();
        assert!(run.timed_out);
        assert!(run.time_ms < 2_000);
        let (r, _root) = job("#include <cstdio>\nint main() { for (int i = 0; i < 1000000; ++i) std::putchar('a'); }", "", 5_000).await;
        let run = r.run.unwrap();
        assert!(run.truncated);
        assert_eq!(run.stdout.len(), OUTPUT_CAP_BYTES);
        assert_eq!(run.exit_code, Some(0));
    }
}
