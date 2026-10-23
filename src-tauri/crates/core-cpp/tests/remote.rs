//! Isolation suite of the remote runner, through its proxy (the only ingress), as `scripts/runner-test.sh` runs it:
//!   LEITOR_RUNNER_TEST_URL=http://runner-dev-proxy:8080 LEITOR_RUNNER_TEST_TOKEN=dev-runner-token \
//!     cargo test -p core-cpp --test remote -- --test-threads=1
//! Skipped (passes trivially, with a note) when the variables are not set.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use core_cpp::{Backend, CppRequest, CppRunResult, RemoteRunner, RunError, RunResult};

fn config() -> Option<(String, String)> {
    let url = std::env::var("LEITOR_RUNNER_TEST_URL")
        .ok()
        .filter(|v| !v.is_empty());
    let token = std::env::var("LEITOR_RUNNER_TEST_TOKEN")
        .ok()
        .filter(|v| !v.is_empty());
    match (url, token) {
        (Some(url), Some(token)) => Some((url, token)),
        _ => {
            eprintln!(
                "LEITOR_RUNNER_TEST_URL/LEITOR_RUNNER_TEST_TOKEN not set: skipping the remote runner suite"
            );
            None
        }
    }
}

fn runner() -> Option<RemoteRunner> {
    let (url, token) = config()?;
    Some(RemoteRunner::new(&url, &token).expect("runner URL"))
}

fn request(source: &str, stdin: &str, timeout_ms: Option<u64>) -> CppRequest {
    CppRequest {
        files: BTreeMap::from([("main.cpp".to_owned(), source.to_owned())]),
        stdin: stdin.to_owned(),
        timeout_ms,
    }
}

async fn run(runner: &RemoteRunner, source: &str, timeout_ms: Option<u64>) -> CppRunResult {
    runner
        .run(&request(source, "", timeout_ms))
        .await
        .expect("remote run")
}

fn ran(result: &CppRunResult) -> &RunResult {
    assert_eq!(result.backend, Backend::Remote);
    assert!(
        result.compile.ok,
        "compile failed: {}",
        result.compile.stderr
    );
    result.run.as_ref().expect("run result")
}

fn endpoint(path: &str) -> String {
    let (url, _) = config().unwrap();
    format!("{}/{path}", url.trim_end_matches('/'))
}

#[tokio::test]
async fn t01_testes_and_saida_work_remotely() {
    let Some(runner) = runner() else { return };
    runner.health().await.expect("health");
    let result = run(
        &runner,
        "#include \"check.hpp\"\nint soma(int a, int b) { return a + b; }\nint main() {\n  CHECK(soma(1, 2) == 3);\n  CHECK(soma(2, 2) == 5);\n}\n",
        None,
    )
    .await;
    assert!(
        result
            .compiler
            .as_deref()
            .unwrap_or_default()
            .contains("g++"),
        "{:?}",
        result.compiler
    );
    let r = ran(&result);
    assert_eq!(
        r.stdout,
        "PASS soma(1, 2) == 3\nFAIL soma(2, 2) == 5 (main.cpp:5)\n"
    );
    assert_eq!(r.exit_code, Some(1));

    let result = runner
        .run(&request(
            "#include <iostream>\n#include <string>\nint main() { std::string n; std::getline(std::cin, n); std::cout << \"Olá, \" << n << \"!\" << std::endl; }\n",
            "mundo\n",
            None,
        ))
        .await
        .unwrap();
    let r = ran(&result);
    assert_eq!(r.stdout, "Olá, mundo!\n");
    assert_eq!(r.exit_code, Some(0));
    assert!(!r.timed_out);

    let result = run(&runner, "int main() { return 0 }\n", None).await;
    assert!(!result.compile.ok);
    assert!(result.compile.stderr.contains("error"));
    assert!(result.run.is_none());
}

const NETWORK_PROBE: &str = r#"
#include <arpa/inet.h>
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

static bool try_connect(const sockaddr* addr, socklen_t len) {
  int s = socket(addr->sa_family, SOCK_STREAM, 0);
  if (s < 0) return false;
  fcntl(s, F_SETFL, O_NONBLOCK);
  if (connect(s, addr, len) == 0) { close(s); return true; }
  if (errno != EINPROGRESS) { close(s); return false; }
  pollfd p{s, POLLOUT, 0};
  if (poll(&p, 1, 2000) <= 0) { close(s); return false; }
  int err = 0;
  socklen_t elen = sizeof err;
  getsockopt(s, SOL_SOCKET, SO_ERROR, &err, &elen);
  close(s);
  return err == 0;
}

static bool try_host(const char* host, const char* port) {
  addrinfo hints{};
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  if (getaddrinfo(host, port, &hints, &res) != 0) return false;
  bool ok = false;
  for (addrinfo* p = res; p && !ok; p = p->ai_next) ok = try_connect(p->ai_addr, p->ai_addrlen);
  freeaddrinfo(res);
  return ok;
}

int main() {
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(80);
  inet_pton(AF_INET, "1.1.1.1", &a.sin_addr);
  std::printf("ip %s\n", try_connect(reinterpret_cast<sockaddr*>(&a), sizeof a) ? "OPEN" : "BLOCKED");
  std::fflush(stdout);
  std::printf("ankisync %s\n", try_host("ankisync-dev", "8080") ? "OPEN" : "BLOCKED");
  std::fflush(stdout);
  addrinfo hints{};
  hints.ai_socktype = SOCK_STREAM;
  addrinfo* res = nullptr;
  int rc = getaddrinfo("example.com", "80", &hints, &res);
  if (rc == 0) freeaddrinfo(res);
  std::printf("dns %s\n", rc == 0 ? "RESOLVED" : "BLOCKED");
}
"#;

#[tokio::test]
async fn t02_network_access_fails() {
    let Some(runner) = runner() else { return };
    let result = run(&runner, NETWORK_PROBE, None).await;
    let r = ran(&result);
    assert!(r.stdout.contains("ip BLOCKED\n"), "{r:?}");
    assert!(r.stdout.contains("ankisync BLOCKED\n"), "{r:?}");
    assert!(r.stdout.contains("dns BLOCKED\n"), "{r:?}");
    assert!(!r.stdout.contains("OPEN") && !r.stdout.contains("RESOLVED"));
}

#[tokio::test]
async fn t03_infinite_loop_is_killed() {
    let Some(runner) = runner() else { return };
    let start = Instant::now();
    let result = run(&runner, "int main() { for (;;) {} }\n", None).await;
    let r = ran(&result);
    let total = start.elapsed();
    assert!(r.timed_out, "{r:?}");
    assert!(total < Duration::from_secs(8), "request took {total:?}");
    assert!(r.signal.is_some(), "{r:?}");
}

#[tokio::test]
async fn t04_fork_bomb_is_contained() {
    let Some(runner) = runner() else { return };
    let result = run(
        &runner,
        "#include <unistd.h>\nint main() { while (1) fork(); }\n",
        Some(3_000),
    )
    .await;
    let r = ran(&result);
    assert!(r.timed_out || r.signal.is_some(), "{r:?}");
    let start = Instant::now();
    runner.health().await.expect("health after the fork bomb");
    let result = runner
        .run(&request(
            "#include <cstdio>\nint main() { std::puts(\"vivo\"); }\n",
            "",
            None,
        ))
        .await
        .expect("normal run after the fork bomb");
    assert_eq!(ran(&result).stdout, "vivo\n");
    assert!(start.elapsed() < Duration::from_secs(15));
}

#[tokio::test]
async fn t05_file_size_is_limited() {
    let Some(runner) = runner() else { return };
    let writer = "#include <csignal>\n#include <cstdio>\n#include <fcntl.h>\n#include <unistd.h>\n#include <vector>\nint main() {\n  IGNORE\n  int fd = open(\"big.bin\", O_WRONLY | O_CREAT | O_TRUNC, 0644);\n  if (fd < 0) { std::puts(\"open failed\"); return 2; }\n  std::vector<char> chunk(1 << 20, 'x');\n  long total = 0;\n  for (int i = 0; i < 20; ++i) {\n    ssize_t n = write(fd, chunk.data(), chunk.size());\n    if (n > 0) total += n;\n    if (n != (ssize_t)chunk.size()) break;\n  }\n  close(fd);\n  std::printf(\"wrote %ld\\n\", total);\n}\n";
    // Default action: SIGXFSZ kills the program.
    let result = run(&runner, &writer.replace("IGNORE", ""), None).await;
    let r = ran(&result);
    assert_eq!(r.signal.as_deref(), Some("SIGXFSZ"), "{r:?}");
    assert!(!r.stdout.contains("wrote"));
    // Ignoring the signal: the writes stop at 10 MiB.
    let result = run(
        &runner,
        &writer.replace("IGNORE", "std::signal(SIGXFSZ, SIG_IGN);"),
        None,
    )
    .await;
    let r = ran(&result);
    let written: u64 = r
        .stdout
        .trim()
        .strip_prefix("wrote ")
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("{r:?}"));
    assert!(written <= 10 * 1024 * 1024, "wrote {written}");
}

#[tokio::test]
async fn t06_one_gib_allocation_fails() {
    let Some(runner) = runner() else { return };
    let source = "#include <cstdio>\n#include <cstdlib>\n#include <cstring>\nint main() {\n  const size_t n = 1UL << 30;\n  char* p = static_cast<char*>(std::malloc(n));\n  if (!p) { std::puts(\"alloc failed\"); return 1; }\n  std::memset(p, 1, n);\n  std::puts(\"touched\");\n}\n";
    let result = run(&runner, source, None).await;
    let r = ran(&result);
    assert!(!r.stdout.contains("touched"), "{r:?}");
    assert!(
        r.stdout.contains("alloc failed") || r.signal.is_some(),
        "{r:?}"
    );
    assert_ne!(r.exit_code, Some(0));
}

#[tokio::test]
async fn t07_root_is_read_only_and_work_is_writable() {
    let Some(runner) = runner() else { return };
    let source = "#include <cstdio>\nstatic void probe(const char* path) {\n  FILE* f = std::fopen(path, \"w\");\n  std::printf(\"%s %s\\n\", path, f ? \"WRITABLE\" : \"DENIED\");\n  if (f) std::fclose(f);\n}\nint main() {\n  probe(\"/etc/x\");\n  probe(\"/usr/x\");\n  probe(\"/x\");\n  probe(\"/usr/local/bin/x\");\n  probe(\"local.txt\");\n  probe(\"/work/x\");\n  std::remove(\"/work/x\");\n}\n";
    let result = run(&runner, source, None).await;
    let r = ran(&result);
    for denied in [
        "/etc/x DENIED",
        "/usr/x DENIED",
        "/x DENIED",
        "/usr/local/bin/x DENIED",
    ] {
        assert!(r.stdout.contains(denied), "{denied}: {r:?}");
    }
    for allowed in ["local.txt WRITABLE", "/work/x WRITABLE"] {
        assert!(r.stdout.contains(allowed), "{allowed}: {r:?}");
    }
}

#[tokio::test]
async fn t08_token_is_required() {
    let Some((url, token)) = config() else { return };
    let wrong = RemoteRunner::new(&url, &format!("{token}-wrong")).unwrap();
    let err = wrong
        .run(&request("int main() {}\n", "", None))
        .await
        .unwrap_err();
    assert_eq!(err, RunError::RemoteAuth);
    // No Authorization header at all.
    let response = reqwest::Client::new()
        .post(endpoint("run"))
        .json(&serde_json::json!({"language": "cpp", "files": {"main.cpp": "int main() {}"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    // Health needs no token.
    wrong.health().await.unwrap();
}

#[tokio::test]
async fn t09_concurrent_runs_are_serialized() {
    let Some(runner) = runner() else { return };
    let source = "#include <chrono>\n#include <cstdio>\n#include <thread>\nstatic long long now() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }\nint main() {\n  long long start = now();\n  std::this_thread::sleep_for(std::chrono::milliseconds(1500));\n  std::printf(\"%lld %lld\\n\", start, now());\n}\n";
    let (a, b) = tokio::join!(run(&runner, source, None), run(&runner, source, None));
    let window = |r: &CppRunResult| -> (i64, i64) {
        let v: Vec<i64> = ran(r)
            .stdout
            .split_whitespace()
            .map(|x| x.parse().unwrap())
            .collect();
        (v[0], v[1])
    };
    let (a, b) = (window(&a), window(&b));
    assert!(a.1 <= b.0 || b.1 <= a.0, "run windows overlap: {a:?} {b:?}");
}

#[tokio::test]
async fn t10_oversized_requests_are_refused() {
    let Some((url, token)) = config() else { return };
    let runner = RemoteRunner::new(&url, &token).unwrap();
    // Checked by the client before sending.
    let err = runner
        .run(&request(&"x".repeat(600 * 1024), "", None))
        .await
        .unwrap_err();
    assert_eq!(err, RunError::TooLarge);
    let client = reqwest::Client::new();
    // Over the runner's source limit but under the body limit: the runner's own validation.
    let response = client
        .post(endpoint("run"))
        .bearer_auth(&token)
        .json(
            &serde_json::json!({"language": "cpp", "files": {"main.cpp": "x".repeat(600 * 1024)}}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    // Over the 1 MiB body limit.
    let response = client
        .post(endpoint("run"))
        .bearer_auth(&token)
        .header("content-type", "application/json")
        .body(vec![b' '; 2 * 1024 * 1024])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::PAYLOAD_TOO_LARGE);
    // Malformed requests are invalid, not crashes.
    let response = client
        .post(endpoint("run"))
        .bearer_auth(&token)
        .json(&serde_json::json!({"language": "python", "files": {"main.py": "print(1)"}}))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    runner.health().await.unwrap();
}

/// Files a program leaves outside its job directory (the shared /tmp, the /work root) never reach the next job, and
/// filling them doesn't break the next compilation (the compiler's temporary files go to the job's own TMPDIR).
#[tokio::test]
async fn t14_files_left_behind_never_reach_the_next_job() {
    let Some(runner) = runner() else { return };
    // Writes up to ~9 MB per file (under the 10 MB file limit) until each place is full or the cap is reached.
    let fill = "#include <cstdio>\n#include <cstdlib>\n#include <string>\nstatic int fill(const std::string& prefix) {\n  static char block[1 << 20];\n  int files = 0;\n  for (int i = 0; i < 12; ++i) {\n    FILE* f = std::fopen((prefix + std::to_string(i)).c_str(), \"w\");\n    if (!f) break;\n    ++files;\n    bool full = false;\n    for (int k = 0; k < 9; ++k) if (std::fwrite(block, 1, sizeof block, f) != sizeof block) { full = true; break; }\n    if (std::fclose(f) != 0) full = true;\n    if (full) break;\n  }\n  return files;\n}\nint main() {\n  std::printf(\"tmp %d\\n\", fill(\"/tmp/leak-\"));\n  std::printf(\"work %d\\n\", fill(\"/work/leak-\"));\n  std::printf(\"tmpdir %s\\n\", std::getenv(\"TMPDIR\") ? \"set\" : \"unset\");\n}\n";
    let result = run(&runner, fill, Some(10_000)).await;
    let r = ran(&result);
    assert!(r.stdout.contains("tmpdir set"), "{r:?}");
    // The next job compiles and runs, and sees none of those files.
    let probe = "#include <cstdio>\n#include <initializer_list>\nint main() {\n  for (const char* p : {\"/tmp/leak-0\", \"/work/leak-0\"}) {\n    FILE* f = std::fopen(p, \"r\");\n    std::printf(\"%s %s\\n\", p, f ? \"LEAKED\" : \"GONE\");\n    if (f) std::fclose(f);\n  }\n}\n";
    let result = run(&runner, probe, None).await;
    assert!(result.compile.ok, "{}", result.compile.stderr);
    let r = ran(&result);
    assert_eq!(r.stdout, "/tmp/leak-0 GONE\n/work/leak-0 GONE\n", "{r:?}");
}

/// Signals every process of another uid (the runner server, the container's init) with SIGKILL from a process that
/// left the job's process group: all must fail. The job runs as its own uid, so it can't touch the server.
const KILL_FOREIGN: &str = r#"#include <cerrno>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <string>
#include <sys/wait.h>
#include <unistd.h>
static long uid_of(const char* pid) {
  std::string path = std::string("/proc/") + pid + "/status";
  FILE* f = std::fopen(path.c_str(), "r");
  if (!f) return -1;
  char line[256];
  long uid = -1;
  while (std::fgets(line, sizeof line, f)) {
    if (std::strncmp(line, "Uid:", 4) == 0) { uid = std::strtol(line + 4, nullptr, 10); break; }
  }
  std::fclose(f);
  return uid;
}
int main() {
  pid_t child = fork();
  if (child == 0) {
    setsid();
    int foreign = 0, denied = 0;
    DIR* proc = opendir("/proc");
    while (dirent* e = readdir(proc)) {
      char* end;
      long pid = std::strtol(e->d_name, &end, 10);
      if (*end || pid <= 0) continue;
      long uid = uid_of(e->d_name);
      if (uid < 0 || uid == (long)getuid()) continue;
      ++foreign;
      if (kill((pid_t)pid, SIGKILL) != 0 && errno == EPERM) ++denied;
    }
    closedir(proc);
    std::printf("foreign %d denied %d\n", foreign, denied);
    std::fflush(stdout);
    _exit(0);
  }
  waitpid(child, nullptr, 0);
}
"#;

#[tokio::test]
async fn t11_program_cannot_kill_the_server() {
    let Some(runner) = runner() else { return };
    let result = run(&runner, KILL_FOREIGN, None).await;
    let r = ran(&result);
    let counts: Vec<u32> = r
        .stdout
        .split_whitespace()
        .filter_map(|w| w.parse().ok())
        .collect();
    let [foreign, denied] = counts[..] else {
        panic!("{r:?}")
    };
    // At least the container's init and the server itself.
    assert!(foreign >= 2, "{r:?}");
    assert_eq!(foreign, denied, "{r:?}");
    runner
        .health()
        .await
        .expect("health after the kill attempt");
    let result = run(
        &runner,
        "#include <cstdio>\nint main() { std::puts(\"vivo\"); }\n",
        None,
    )
    .await;
    assert_eq!(ran(&result).stdout, "vivo\n");
}

/// Leaves a `setsid` child sleeping (holding the output pipes) and marker files in every writable place.
const ESCAPE: &str = r#"#include <cstdio>
#include <fcntl.h>
#include <initializer_list>
#include <sys/stat.h>
#include <unistd.h>
int main() {
  int ready[2];
  if (pipe(ready) != 0) return 2;
  if (fork() == 0) {
    setsid();
    for (const char* path : {"/work/escape-marker", "/tmp/escape-marker", "/dev/shm/escape-marker", "escape-marker"}) {
      int fd = open(path, O_WRONLY | O_CREAT, 0644);
      if (fd >= 0) close(fd);
    }
    mkdir("/tmp/escape-dir", 0500);
    char byte = 1;
    if (write(ready[1], &byte, 1) != 1) _exit(2);
    sleep(120);
    _exit(0);
  }
  char byte;
  if (read(ready[0], &byte, 1) != 1) return 3;
  std::puts("escaped");
}
"#;

/// Lists the processes of its own uid other than itself and its ancestors, and which markers survived.
const SURVIVORS: &str = r#"#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <initializer_list>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
static long field(long pid, const char* key) {
  std::string path = "/proc/" + std::to_string(pid) + "/status";
  FILE* f = std::fopen(path.c_str(), "r");
  if (!f) return -1;
  char line[256];
  long value = -1;
  size_t n = std::strlen(key);
  while (std::fgets(line, sizeof line, f)) {
    if (std::strncmp(line, key, n) == 0) { value = std::strtol(line + n, nullptr, 10); break; }
  }
  std::fclose(f);
  return value;
}
int main() {
  long me = getpid();
  DIR* proc = opendir("/proc");
  while (dirent* e = readdir(proc)) {
    char* end;
    long pid = std::strtol(e->d_name, &end, 10);
    if (*end || pid <= 0 || pid == me || field(pid, "Uid:") != (long)getuid()) continue;
    // Skip our own ancestors (prlimit/timeout chain).
    bool ancestor = false;
    for (long p = field(me, "PPid:"); p > 1; p = field(p, "PPid:")) if (p == pid) { ancestor = true; break; }
    if (!ancestor) std::printf("survivor %ld\n", pid);
  }
  closedir(proc);
  struct stat st;
  for (const char* path : {"/work/escape-marker", "/tmp/escape-marker", "/dev/shm/escape-marker", "/tmp/escape-dir"}) {
    std::printf("%s %s\n", path, stat(path, &st) == 0 ? "PRESENT" : "GONE");
  }
}
"#;

#[tokio::test]
async fn t12_setsid_escape_does_not_outlive_the_job() {
    let Some(runner) = runner() else { return };
    let start = Instant::now();
    let result = run(&runner, ESCAPE, None).await;
    let r = ran(&result);
    assert_eq!(r.stdout, "escaped\n", "{r:?}");
    // The escaped child holds the pipes: the response comes back because it is killed, not after a grace period.
    assert!(
        start.elapsed() < Duration::from_secs(8),
        "{:?}",
        start.elapsed()
    );
    let result = run(&runner, SURVIVORS, None).await;
    let r = ran(&result);
    assert!(!r.stdout.contains("survivor"), "{r:?}");
    assert!(!r.stdout.contains("PRESENT"), "{r:?}");
    assert_eq!(r.stdout.matches("GONE").count(), 4, "{r:?}");
}

/// Prints its environment and looks for RUNNER_ variables in every readable /proc/<pid>/environ.
const ENVIRONMENT: &str = r#"#include <cstdio>
#include <cstdlib>
#include <dirent.h>
#include <string>
extern char** environ;
int main() {
  for (char** e = environ; *e; ++e) std::printf("env %s\n", *e);
  DIR* proc = opendir("/proc");
  while (dirent* e = readdir(proc)) {
    char* end;
    std::strtol(e->d_name, &end, 10);
    if (*end) continue;
    std::string path = std::string("/proc/") + e->d_name + "/environ";
    FILE* f = std::fopen(path.c_str(), "r");
    if (!f) continue;
    std::string data;
    char buf[4096];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) data.append(buf, n);
    std::fclose(f);
    if (data.find("RUNNER_") != std::string::npos) std::printf("LEAK %s\n", e->d_name);
  }
  closedir(proc);
}
"#;

#[tokio::test]
async fn t13_program_never_sees_the_runner_environment() {
    let Some((_, token)) = config() else { return };
    let runner = runner().unwrap();
    let result = run(&runner, ENVIRONMENT, None).await;
    let r = ran(&result);
    assert!(r.stdout.contains("env PATH="), "{r:?}");
    assert!(!r.stdout.contains("RUNNER_"), "{r:?}");
    assert!(!r.stdout.contains("LEAK"), "{r:?}");
    assert!(!r.stdout.contains(&token), "{r:?}");
}
