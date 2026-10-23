//! `runner` — the C++ runner service. `runner --healthcheck` checks a running instance (Docker HEALTHCHECK, no
//! curl in the image).
//!
//! Environment: `RUNNER_TOKEN` (required, never logged, never passed to a job), `RUNNER_PORT` (8080),
//! `RUNNER_WORK_DIR` (`/work`), `RUNNER_CXX` (`g++`), `RUNNER_NPROC` (64), `RUNNER_JOB_USER` (`uid:gid` the jobs run
//! as; the image sets `10002:10002` and starts the server as 10001 with ambient CAP_SETUID/CAP_SETGID — see the
//! Dockerfile). `runner --reap <uid> [dir…]` is the reaper the server runs as the job user (exec.rs).

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use leitor_runner::api::{AppState, router};
use leitor_runner::exec::{DEFAULT_NPROC, ExecConfig, JobUser, Reaper, SHARED_TMP_DIRS, reap_main};

fn port() -> u16 {
    std::env::var("RUNNER_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--healthcheck") => return healthcheck(),
        Some("--reap") => {
            return match reap_main(&args[1..]) {
                Ok(()) => ExitCode::SUCCESS,
                Err(err) => {
                    eprintln!("{err}");
                    ExitCode::from(2)
                }
            };
        }
        _ => {}
    }
    // Nothing else of this uid may read our memory or /proc/<pid>/environ (which still holds RUNNER_TOKEN).
    if let Err(err) = nix::sys::prctl::set_dumpable(false) {
        eprintln!("prctl(PR_SET_DUMPABLE, 0): {err}");
        return ExitCode::FAILURE;
    }
    let token = std::env::var("RUNNER_TOKEN").unwrap_or_default();
    let token = token.trim();
    if token.is_empty() {
        eprintln!("RUNNER_TOKEN is empty: refusing to start");
        return ExitCode::from(2);
    }
    let work_root =
        PathBuf::from(std::env::var("RUNNER_WORK_DIR").unwrap_or_else(|_| "/work".into()));
    let compiler = std::env::var("RUNNER_CXX").unwrap_or_else(|_| "g++".into());
    let nproc = std::env::var("RUNNER_NPROC")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(DEFAULT_NPROC);
    let reaper = match std::env::var("RUNNER_JOB_USER")
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        None => {
            eprintln!(
                "warning: RUNNER_JOB_USER is not set: jobs run as the runner's own uid (development only)"
            );
            None
        }
        Some(value) => {
            let Some(user) = JobUser::parse(&value) else {
                eprintln!(
                    "RUNNER_JOB_USER {value:?} is not uid[:gid] (non-root): refusing to start"
                );
                return ExitCode::from(2);
            };
            let own = nix::unistd::getuid().as_raw();
            if user.uid == own || nix::unistd::geteuid().as_raw() == user.uid {
                eprintln!(
                    "RUNNER_JOB_USER must differ from the runner's uid ({own}): refusing to start"
                );
                return ExitCode::from(2);
            }
            let exe = match std::env::current_exe() {
                Ok(exe) => exe,
                Err(err) => {
                    eprintln!("current_exe: {err}");
                    return ExitCode::FAILURE;
                }
            };
            Some(Reaper { user, exe })
        }
    };

    // A single thread: the runner's own tasks count towards the uid's process limit (`--nproc`).
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("tokio runtime: {err}");
            return ExitCode::FAILURE;
        }
    };
    runtime.block_on(async move {
        if let Some(reaper) = &reaper {
            // Proves the switch to the job user works (fail closed) and clears leftovers of a previous instance.
            let mut dirs = vec![work_root.as_path()];
            dirs.extend(SHARED_TMP_DIRS.iter().map(std::path::Path::new));
            if let Err(err) = reaper.reap(&dirs).await {
                eprintln!("{err}: refusing to start");
                return ExitCode::FAILURE;
            }
        }
        let config = ExecConfig::detect(work_root, compiler, nproc, reaper).await;
        eprintln!(
            "runner: compiler {:?}, work dir {}, jobs as {}",
            config.compiler_version.as_deref().unwrap_or("not found"),
            config.work_root.display(),
            config.reaper.as_ref().map_or_else(
                || "the runner's uid".to_owned(),
                |r| format!("{}:{}", r.user.uid, r.user.gid)
            )
        );
        let state = AppState::new(token, config.executor());
        let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port()));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("bind {addr}: {err}");
                return ExitCode::FAILURE;
            }
        };
        eprintln!("runner: listening on {addr}");
        match axum::serve(listener, router(state))
            .with_graceful_shutdown(shutdown())
            .await
        {
            Ok(()) => ExitCode::SUCCESS,
            Err(err) => {
                eprintln!("server: {err}");
                ExitCode::FAILURE
            }
        }
    })
}

async fn shutdown() {
    let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(term) => term,
        Err(_) => return std::future::pending().await,
    };
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

fn healthcheck() -> ExitCode {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port()));
    let check = || -> std::io::Result<bool> {
        let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))?;
        stream.set_read_timeout(Some(Duration::from_secs(2)))?;
        stream
            .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut response = Vec::new();
        stream.take(4096).read_to_end(&mut response)?;
        Ok(response.starts_with(b"HTTP/1.1 200") && response.ends_with(b"ok"))
    };
    match check() {
        Ok(true) => ExitCode::SUCCESS,
        _ => ExitCode::FAILURE,
    }
}
