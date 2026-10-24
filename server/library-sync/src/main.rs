//! `library-sync` — serve (default), `--healthcheck`, `device list`, `device revoke <name>`.
//!
//! Environment: `LIBRARY_SYNC_DATA` (default `/data`), `LIBRARY_SYNC_PORT` (default 8090), `LIBRARY_SYNC_USER` and
//! `LIBRARY_SYNC_PASSWORD` (the library login; the password is required to serve). No secret is ever printed.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::ExitCode;
use std::time::Duration;

use leitor_library_sync::{AppState, Config, db, now_ms, router};

fn env(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_owned())
}

fn port() -> u16 {
    env("LIBRARY_SYNC_PORT", "8090").parse().unwrap_or(8090)
}

fn data_dir() -> PathBuf {
    PathBuf::from(env("LIBRARY_SYNC_DATA", "/data"))
}

/// GET /v1/health on localhost (the image has no curl).
fn healthcheck() -> ExitCode {
    let addr = SocketAddr::from(([127, 0, 0, 1], port()));
    let ok = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).and_then(|mut s| {
        s.set_read_timeout(Some(Duration::from_secs(2)))?;
        s.write_all(b"GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")?;
        let mut out = String::new();
        s.read_to_string(&mut out)?;
        Ok(out.starts_with("HTTP/1.1 200"))
    });
    if matches!(ok, Ok(true)) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn devices(args: &[String]) -> ExitCode {
    let conn = match db::open(&data_dir().join("library.sqlite")) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("não foi possível abrir o banco: {e}");
            return ExitCode::FAILURE;
        }
    };
    match args {
        [cmd] if cmd == "list" => match db::devices(&conn) {
            Ok(list) => {
                println!("id\tnome\tcriado\túltimo acesso\tstatus");
                for d in list {
                    let status = if d.revoked { "revogado" } else { "ativo" };
                    println!(
                        "{}\t{}\t{}\t{}\t{status}",
                        d.id, d.name, d.created_at, d.last_seen
                    );
                }
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        [cmd, name] if cmd == "revoke" => match db::revoke_device_named(&conn, name) {
            Ok(n) => {
                println!("{n} aparelho(s) revogado(s).");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        _ => {
            eprintln!("uso: library-sync device list | library-sync device revoke <nome>");
            ExitCode::from(2)
        }
    }
}

async fn serve() -> ExitCode {
    let config = Config {
        data_dir: data_dir(),
        user: env("LIBRARY_SYNC_USER", "leitor"),
        password: env("LIBRARY_SYNC_PASSWORD", ""),
        fail_delay: leitor_library_sync::FAIL_DELAY,
    };
    if config.password.len() < 12 {
        eprintln!("defina LIBRARY_SYNC_PASSWORD (pelo menos 12 caracteres) no .env");
        return ExitCode::FAILURE;
    }
    let state = match AppState::open(config) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("não foi possível abrir os dados: {e}");
            return ExitCode::FAILURE;
        }
    };
    let cleaner = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(24 * 3600));
        loop {
            tick.tick().await;
            if let Err(e) = cleaner.cleanup(now_ms()).await {
                eprintln!("library-sync: cleanup failed: {e}");
            }
        }
    });
    let addr = SocketAddr::from(([0, 0, 0, 0], port()));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("não foi possível abrir a porta {addr}: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("library-sync: listening on {addr}");
    // Docker stops with SIGTERM; a terminal with Ctrl+C.
    let shutdown = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    };
    match axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown)
        .await
    {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--healthcheck") => healthcheck(),
        Some("device") => devices(&args[1..]),
        None | Some("serve") => match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt.block_on(serve()),
            Err(e) => {
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        },
        Some(other) => {
            eprintln!("comando desconhecido: {other}");
            ExitCode::from(2)
        }
    }
}
