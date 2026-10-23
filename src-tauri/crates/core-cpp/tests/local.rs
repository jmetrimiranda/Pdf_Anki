//! The local runner with the compiler of the devcontainer (g++, clang-format, util-linux prlimit).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use core_cpp::{
    Backend, CppRequest, CppRunResult, OUTPUT_CAP_BYTES, RunError, detect_local, format_cpp,
    run_local,
};

fn request(files: &[(&str, &str)], stdin: &str) -> CppRequest {
    CppRequest {
        files: files
            .iter()
            .map(|(n, c)| ((*n).to_owned(), (*c).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        stdin: stdin.to_owned(),
        timeout_ms: None,
    }
}

fn run(source: &str, stdin: &str) -> CppRunResult {
    run_local(&request(&[("main.cpp", source)], stdin)).expect("run_local")
}

fn ran(result: &CppRunResult) -> &core_cpp::RunResult {
    assert!(
        result.compile.ok,
        "compile failed: {}",
        result.compile.stderr
    );
    result.run.as_ref().expect("run result")
}

/// Live (non-zombie) processes whose process group is `pgid`.
#[cfg(target_os = "linux")]
fn live_group_members(pgid: i32) -> Vec<i32> {
    let mut members = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let Some(close) = stat.rfind(')') else {
            continue;
        };
        let fields: Vec<&str> = stat[close + 1..].split_whitespace().collect();
        // state ppid pgrp …
        if fields.len() > 2 && fields[0] != "Z" && fields[0] != "X" && fields[2].parse() == Ok(pgid)
        {
            members.push(entry.file_name().to_string_lossy().parse().unwrap_or(0));
        }
    }
    members
}

const SOMA: &str = "int soma(int a, int b) { return a + b; }\n";

#[test]
fn testes_mode_all_pass() {
    let source = format!(
        "#include \"check.hpp\"\n{SOMA}int main() {{\n  CHECK(soma(1, 2) == 3);\n  CHECK(soma(-1, 1) == 0);\n}}\n"
    );
    let result = run(&source, "");
    assert_eq!(result.backend, Backend::Local);
    assert!(result.compiler.is_some());
    let run = ran(&result);
    assert_eq!(run.stdout, "PASS soma(1, 2) == 3\nPASS soma(-1, 1) == 0\n");
    assert_eq!(run.exit_code, Some(0));
    assert!(!run.timed_out);
}

#[test]
fn testes_mode_failure_line_and_exit_code() {
    let source = format!(
        "#include \"check.hpp\"\n{SOMA}int main() {{\n  CHECK(soma(1, 2) == 3);\n  CHECK(soma(2, 2) == 5);\n}}\n"
    );
    let run = run(&source, "");
    let run = ran(&run);
    assert_eq!(
        run.stdout,
        "PASS soma(1, 2) == 3\nFAIL soma(2, 2) == 5 (main.cpp:5)\n"
    );
    assert_ne!(run.exit_code, Some(0));
    assert_eq!(run.exit_code, Some(1));
}

#[test]
fn testes_mode_with_separate_solution_and_header() {
    let result = run_local(&request(
        &[
            ("solucao.cpp", "#include \"solucao.hpp\"\n#include <vector>\nint total(const std::vector<int>& v) { int s = 0; for (int x : v) s += x; return s; }\n"),
            ("solucao.hpp", "#pragma once\n#include <vector>\nint total(const std::vector<int>& v);\n"),
            ("testes.cpp", "#include \"check.hpp\"\n#include \"solucao.hpp\"\nint main() { CHECK(total(std::vector<int>{1, 2, 3}) == 6); }\n"),
        ],
        "",
    ))
    .unwrap();
    let run = ran(&result);
    assert_eq!(run.stdout, "PASS total(std::vector<int>{1, 2, 3}) == 6\n");
    assert_eq!(run.exit_code, Some(0));
}

#[test]
fn saida_mode_stdout() {
    let result = run(
        "#include <iostream>\nint main() { std::cout << \"Olá, mundo!\" << std::endl; }\n",
        "",
    );
    let run = ran(&result);
    assert_eq!(run.stdout, "Olá, mundo!\n");
    assert_eq!(run.stderr, "");
    assert_eq!(run.exit_code, Some(0));
    assert_eq!(run.signal, None);
}

#[test]
fn stdin_is_echoed() {
    let source = "#include <iostream>\n#include <string>\nint main() { std::string line; while (std::getline(std::cin, line)) std::cout << \"> \" << line << '\\n'; }\n";
    let result = run(source, "um\ndois\n");
    assert_eq!(ran(&result).stdout, "> um\n> dois\n");
}

#[test]
fn compile_error_has_stderr_and_no_run() {
    let result = run("int main() { return 0 }\n", "");
    assert!(!result.compile.ok);
    assert!(
        result.compile.stderr.contains("error"),
        "{}",
        result.compile.stderr
    );
    assert!(
        result.compile.stderr.contains("main.cpp"),
        "{}",
        result.compile.stderr
    );
    assert!(result.run.is_none());
}

#[cfg(target_os = "linux")]
#[test]
fn infinite_loop_times_out_and_leaves_no_process() {
    // A forked child spins too: the whole process group must go.
    let source = "#include <cstdio>\n#include <unistd.h>\nint main() {\n  if (fork() == 0) { for (;;) {} }\n  std::printf(\"%d %d\\n\", (int)getpid(), (int)getpgrp());\n  std::fflush(stdout);\n  for (;;) {}\n}\n";
    let start = Instant::now();
    let result = run(source, "");
    let run = ran(&result);
    assert!(
        start.elapsed() <= Duration::from_secs(11 + 10),
        "compile + run took {:?}",
        start.elapsed()
    );
    assert!(run.timed_out, "{run:?}");
    assert!(
        run.time_ms >= 9_900 && run.time_ms <= 11_000,
        "time_ms {}",
        run.time_ms
    );
    assert_eq!(run.signal.as_deref(), Some("SIGKILL"));
    let ids: Vec<i32> = run
        .stdout
        .split_whitespace()
        .map(|v| v.parse().unwrap())
        .collect();
    assert_eq!(ids.len(), 2, "{}", run.stdout);
    assert_eq!(ids[0], ids[1], "the program leads its own process group");
    // Killed processes can take a moment to disappear from /proc.
    let deadline = Instant::now() + Duration::from_secs(2);
    while !live_group_members(ids[1]).is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(live_group_members(ids[1]), Vec::<i32>::new());
}

#[test]
fn lower_timeout_is_honoured() {
    let mut req = request(&[("main.cpp", "int main() { for (;;) {} }\n")], "");
    req.timeout_ms = Some(1_000);
    let result = run_local(&req).unwrap();
    let run = ran(&result);
    assert!(run.timed_out);
    assert!(run.time_ms < 2_000, "{}", run.time_ms);
    // Never raised above 10 s.
    req.timeout_ms = Some(1_000_000);
    assert_eq!(core_cpp::effective_run_timeout_ms(&req), 10_000);
}

#[cfg(target_os = "linux")]
#[test]
fn allocating_two_gib_fails_fast() {
    let source = "#include <cstring>\n#include <cstdio>\nint main() {\n  const unsigned long n = 2UL << 30;\n  char* p = new char[n];\n  std::memset(p, 1, n);\n  std::printf(\"%d\\n\", p[n - 1]);\n}\n";
    let result = run(source, "");
    let run = ran(&result);
    assert!(!run.timed_out, "{run:?}");
    assert!(run.exit_code != Some(0), "{run:?}");
    assert!(run.signal.is_some() || run.exit_code.is_some_and(|c| c != 0));
    assert!(run.time_ms < 5_000);
}

#[cfg(target_os = "linux")]
#[test]
fn file_size_is_limited() {
    assert!(
        core_cpp_has_prlimit(),
        "util-linux prlimit is expected in the devcontainer"
    );
    let out = tempfile::tempdir().unwrap();
    let target: PathBuf = out.path().join("big.bin");
    let source = "#include <cstdio>\n#include <iostream>\n#include <string>\n#include <vector>\nint main() {\n  std::string path; std::getline(std::cin, path);\n  FILE* f = std::fopen(path.c_str(), \"wb\");\n  if (!f) return 2;\n  std::vector<char> chunk(1 << 20, 'x');\n  for (int i = 0; i < 20; ++i) {\n    if (std::fwrite(chunk.data(), 1, chunk.size(), f) != chunk.size()) { std::puts(\"short write\"); return 3; }\n  }\n  std::fclose(f);\n  std::puts(\"wrote 20 MB\");\n}\n";
    let result = run(source, &format!("{}\n", target.display()));
    let run = ran(&result);
    assert!(
        run.signal.as_deref() == Some("SIGXFSZ") || run.exit_code.is_some_and(|c| c != 0),
        "{run:?}"
    );
    assert!(!run.stdout.contains("wrote 20 MB"));
    let size = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    assert!(size <= 10 * 1024 * 1024, "file has {size} bytes");
}

#[cfg(target_os = "linux")]
fn core_cpp_has_prlimit() -> bool {
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .any(|d| d.join("prlimit").is_file())
}

#[cfg(target_os = "linux")]
#[test]
fn fork_bomb_is_contained() {
    let source = "#include <cstdio>\n#include <unistd.h>\nint main() {\n  std::printf(\"%d\\n\", (int)getpgrp());\n  std::fflush(stdout);\n  while (1) fork();\n}\n";
    let mut req = request(&[("main.cpp", source)], "");
    req.timeout_ms = Some(3_000);
    let start = Instant::now();
    let result = run_local(&req).unwrap();
    let run = ran(&result);
    assert!(
        start.elapsed() < Duration::from_secs(20),
        "{:?}",
        start.elapsed()
    );
    assert!(run.timed_out || run.signal.is_some(), "{run:?}");
    let pgid: i32 = run.stdout.lines().next().unwrap().trim().parse().unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    while !live_group_members(pgid).is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(live_group_members(pgid), Vec::<i32>::new());
    // This process can still start processes.
    let status = std::process::Command::new("true").status().unwrap();
    assert!(status.success());
}

#[test]
fn output_is_capped() {
    let source = "#include <cstdio>\nint main() { for (int i = 0; i < 1024 * 1024; ++i) std::putchar('a'); std::fputs(\"erro\", stderr); }\n";
    let result = run(source, "");
    let run = ran(&result);
    assert!(run.truncated);
    assert_eq!(run.stdout.len(), OUTPUT_CAP_BYTES);
    assert_eq!(run.stderr, "erro");
    assert_eq!(run.exit_code, Some(0));
}

#[test]
fn invalid_requests_are_refused() {
    for name in ["../main.cpp", "-o.cpp", "main.py", "a b.cpp"] {
        let err = run_local(&request(&[(name, "int main(){}")], "")).unwrap_err();
        assert!(
            matches!(err, RunError::InvalidRequest(_)),
            "{name}: {err:?}"
        );
        assert_eq!(err.code(), "invalid_request");
    }
    let err = run_local(&request(
        &[("main.cpp", "int main(){}"), ("check.hpp", "")],
        "",
    ))
    .unwrap_err();
    assert!(matches!(err, RunError::InvalidRequest(_)), "{err:?}");
    let err = run_local(&request(&[("util.hpp", "")], "")).unwrap_err();
    assert!(matches!(err, RunError::InvalidRequest(_)), "{err:?}");
    let big = "x".repeat(600 * 1024);
    let err = run_local(&request(&[("main.cpp", &big)], "")).unwrap_err();
    assert_eq!(err, RunError::TooLarge);
    let err = run_local(&request(
        &[("main.cpp", "int main(){}")],
        &"i".repeat(1024 * 1024 + 1),
    ))
    .unwrap_err();
    assert_eq!(err, RunError::TooLarge);
    let many: Vec<(String, String)> = (0..17)
        .map(|i| (format!("f{i}.cpp"), String::new()))
        .collect();
    let refs: Vec<(&str, &str)> = many.iter().map(|(n, c)| (n.as_str(), c.as_str())).collect();
    assert!(matches!(
        run_local(&request(&refs, "")).unwrap_err(),
        RunError::InvalidRequest(_)
    ));
}

#[test]
fn temp_dir_is_removed() {
    let source = "#include <cstdio>\n#include <unistd.h>\nint main() { char buf[4096]; if (getcwd(buf, sizeof buf)) std::puts(buf); }\n";
    let result = run(source, "");
    let dir = PathBuf::from(ran(&result).stdout.trim());
    assert!(dir.starts_with(std::env::temp_dir()), "{}", dir.display());
    assert!(
        dir.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("leitor-cpp-")
    );
    assert!(!dir.exists(), "{} still exists", dir.display());

    // Also after a timeout.
    let source = "#include <cstdio>\n#include <unistd.h>\nint main() { char buf[4096]; if (getcwd(buf, sizeof buf)) std::puts(buf); std::fflush(stdout); for (;;) {} }\n";
    let mut req = request(&[("main.cpp", source)], "");
    req.timeout_ms = Some(500);
    let result = run_local(&req).unwrap();
    let run = ran(&result);
    assert!(run.timed_out);
    let dir = PathBuf::from(run.stdout.trim());
    assert!(!dir.as_os_str().is_empty() && !dir.exists());
}

#[test]
fn detects_gpp() {
    let toolchain = detect_local();
    let compiler = toolchain
        .compiler
        .as_ref()
        .expect("a compiler in the devcontainer");
    assert_eq!(compiler.name, "g++");
    assert!(compiler.path.is_absolute());
    assert!(
        compiler.version.contains("g++") || compiler.version.contains("GCC"),
        "{}",
        compiler.version
    );
    assert!(
        toolchain.clang_format.is_some(),
        "clang-format in the devcontainer"
    );
}

#[test]
fn formats_with_clang_format() {
    let (formatted, tool) = format_cpp("int  main( ){return 0;}");
    assert_eq!(tool, Some("clang-format"));
    assert_eq!(formatted.trim_end(), "int main() { return 0; }");
    let (formatted, _) = format_cpp("#include <cstdio>\nint main(){\nstd::puts(\"oi\");\n}\n");
    assert_eq!(
        formatted,
        "#include <cstdio>\nint main() { std::puts(\"oi\"); }\n"
    );
}
