//! Compile and run with the local compiler (desktop).

use std::ffi::OsString;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::process::{Outcome, prlimit, supervise_in, tasks_of_current_uid};
use crate::validate::{CHECK_HEADER, validate_request};
use crate::{
    Backend, CHECK_HPP, COMPILE_TIMEOUT_MS, CompileResult, CppRequest, CppRunResult,
    OUTPUT_CAP_BYTES, RunError, RunResult, detect_local, effective_run_timeout_ms,
};

/// Address space of the compiler (2 GiB) and of the program (1 GiB).
const COMPILE_AS_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const RUN_AS_BYTES: u64 = 1024 * 1024 * 1024;
/// CPU seconds, soft:hard. The soft limit sends SIGXCPU (reported as a timeout); with soft == hard the kernel would
/// send SIGKILL instead, which is indistinguishable from a crash.
const CPU_LIMIT: &str = "10:11";
/// Largest file the program may write.
const RUN_FSIZE_BYTES: u64 = 10 * 1024 * 1024;
/// Processes/threads the program may add to what this user already runs.
const RUN_EXTRA_TASKS: u64 = 128;

const COMPILER_FLAGS: [&str; 4] = ["-std=c++20", "-O0", "-Wall", "-Wextra"];
const PROGRAM: &str = if cfg!(windows) { "prog.exe" } else { "prog" };

/// Compiles and runs `req` with the local compiler in a fresh temporary directory (removed afterwards, also on
/// errors and timeouts). Blocking: call it from a blocking thread.
///
/// [`RunError::RunningAsRoot`] (after validating the request, before touching the compiler or the disk) when
/// [`local_run_refusal`] says so.
pub fn run_local(req: &CppRequest) -> Result<CppRunResult, RunError> {
    let sources = validate_request(&req.files, &req.stdin)?;
    if let Some(refusal) = local_run_refusal() {
        return Err(refusal);
    }
    let compiler = detect_local()
        .compiler
        .as_ref()
        .ok_or(RunError::Unavailable)?;

    let dir = tempfile::Builder::new()
        .prefix("leitor-cpp-")
        .tempdir_in(std::env::temp_dir())?;
    for (name, content) in &req.files {
        std::fs::write(dir.path().join(name), content)?;
    }
    std::fs::write(dir.path().join(CHECK_HEADER), CHECK_HPP)?;

    let mut args: Vec<OsString> = COMPILER_FLAGS.iter().map(OsString::from).collect();
    args.push("-o".into());
    args.push(PROGRAM.into());
    args.extend(sources.iter().map(OsString::from));
    let compile_limits = [
        format!("--cpu={CPU_LIMIT}"),
        format!("--as={COMPILE_AS_BYTES}"),
    ];
    let cmd = limited(&compiler.path, &args, &compile_limits, dir.path());
    let out = supervise_in(
        cmd,
        None,
        Duration::from_millis(COMPILE_TIMEOUT_MS),
        OUTPUT_CAP_BYTES,
        Some(dir.path()),
    )?;
    let compile = compile_result(out);
    let compiler_version = Some(compiler.version.clone()).filter(|v| !v.is_empty());
    if !compile.ok {
        dir.close()?;
        return Ok(CppRunResult {
            backend: Backend::Local,
            compiler: compiler_version,
            compile,
            run: None,
        });
    }

    let mut run_limits = vec![
        format!("--cpu={CPU_LIMIT}"),
        format!("--as={RUN_AS_BYTES}"),
        format!("--fsize={RUN_FSIZE_BYTES}"),
    ];
    if let Some(tasks) = tasks_of_current_uid() {
        run_limits.push(format!("--nproc={}", tasks + RUN_EXTRA_TASKS));
    }
    let program = dir.path().join(PROGRAM);
    let cmd = limited(&program, &[], &run_limits, dir.path());
    let timeout = Duration::from_millis(effective_run_timeout_ms(req));
    let out = supervise_in(
        cmd,
        Some(req.stdin.as_bytes().to_vec()),
        timeout,
        OUTPUT_CAP_BYTES,
        Some(dir.path()),
    )?;
    let run = run_result(out);
    dir.close()?;
    Ok(CppRunResult {
        backend: Backend::Local,
        compiler: compiler_version,
        compile,
        run: Some(run),
    })
}

/// Why [`run_local`] refuses to compile or run anything right now; `None` when it may.
///
/// Refused when this process runs with effective uid 0 (Unix): Linux does not enforce `RLIMIT_NPROC` for root, so the
/// process limit (`prlimit --nproc`) would not contain a fork bomb, and the card's code would run with every privilege
/// of root. Never refused on other platforms. [`format_cpp`](crate::format_cpp) is not affected (it runs no user
/// code).
pub fn local_run_refusal() -> Option<RunError> {
    refusal_for_euid(effective_uid())
}

fn refusal_for_euid(euid: Option<u32>) -> Option<RunError> {
    (euid == Some(0)).then_some(RunError::RunningAsRoot)
}

#[cfg(unix)]
fn effective_uid() -> Option<u32> {
    Some(nix::unistd::geteuid().as_raw())
}

#[cfg(not(unix))]
fn effective_uid() -> Option<u32> {
    None
}

/// `program args…`, wrapped as `prlimit <limits> -- program args…` when prlimit is available.
fn limited(program: &Path, args: &[OsString], limits: &[String], cwd: &Path) -> Command {
    let mut cmd = match prlimit() {
        Some(prlimit) => {
            let mut cmd = Command::new(prlimit);
            cmd.args(limits).arg("--").arg(program);
            cmd
        }
        None => Command::new(program),
    };
    cmd.args(args).current_dir(cwd);
    cmd
}

fn compile_result(out: Outcome) -> CompileResult {
    let ok = out.status.success() && !out.timed_out;
    let mut stderr = out.stderr.into_string();
    if out.timed_out {
        if !stderr.is_empty() && !stderr.ends_with('\n') {
            stderr.push('\n');
        }
        stderr.push_str(&format!(
            "Tempo limite de compilação excedido ({} s).",
            COMPILE_TIMEOUT_MS / 1000
        ));
    }
    CompileResult {
        ok,
        stderr,
        time_ms: millis(out.elapsed),
    }
}

fn run_result(out: Outcome) -> RunResult {
    let signal = out.signal();
    // The CPU limit (SIGXCPU) is a time limit too.
    let timed_out = out.timed_out || signal.as_deref() == Some("SIGXCPU");
    RunResult {
        exit_code: out.status.code(),
        signal,
        time_ms: millis(out.elapsed),
        timed_out,
        truncated: out.stdout.truncated || out.stderr.truncated,
        stdout: out.stdout.into_string(),
        stderr: out.stderr.into_string(),
    }
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_is_refused() {
        assert_eq!(refusal_for_euid(Some(0)), Some(RunError::RunningAsRoot));
        assert_eq!(refusal_for_euid(Some(1000)), None);
        assert_eq!(refusal_for_euid(Some(1)), None);
        // No uid (not Unix): allowed.
        assert_eq!(refusal_for_euid(None), None);
        let err = RunError::RunningAsRoot;
        assert_eq!(err.code(), "running_as_root");
        assert!(err.message_pt().contains("root"), "{}", err.message_pt());
    }

    #[cfg(unix)]
    #[test]
    fn refusal_follows_the_effective_uid() {
        let root = nix::unistd::geteuid().is_root();
        assert_eq!(local_run_refusal().is_some(), root);
    }
}
