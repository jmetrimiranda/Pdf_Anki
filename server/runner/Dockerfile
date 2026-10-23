# Leitor de Estudos C++ runner (spec 11.5). Build context: server/runner.
#   docker build -t leitor-runner server/runner
# Two users: the server runs as runner (10001), every compiler/program as runner-job (10002), so a job can neither
# signal the server nor read its /proc/<pid>/environ, and the server can kill everything of the job uid after each
# job. The container starts as root with only CAP_SETUID/CAP_SETGID (compose: cap_drop ALL + cap_add); setpriv drops
# to 10001 at once, keeping those two as ambient capabilities only so the server can start jobs as 10002 (through
# setpriv again, which clears them before exec). compose adds the rest of the isolation (read-only root, tmpfs
# /work, internal network only, no-new-privileges, pids/memory limits). See docs/tecnico/runner.md.

FROM rust:1.97.1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock check.hpp ./
COPY src ./src
RUN cargo build --release --locked --bin runner

FROM debian:bookworm-slim
# g++ (compile), clang-format (mode estrutura), util-linux (prlimit, setpriv), coreutils (timeout). No curl, no network
# tools.
RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ clang-format util-linux coreutils \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 runner \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /work --shell /usr/sbin/nologin runner \
    && groupadd --gid 10002 runner-job \
    && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /work --shell /usr/sbin/nologin runner-job \
    && mkdir -p /work \
    && chown runner:runner /work
COPY --from=build /src/target/release/runner /usr/local/bin/runner
WORKDIR /work
ENV RUNNER_PORT=8080 RUNNER_WORK_DIR=/work RUNNER_JOB_USER=10002:10002
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 CMD ["/usr/local/bin/runner", "--healthcheck"]
ENTRYPOINT ["setpriv", "--reuid=10001", "--regid=10001", "--clear-groups", "--inh-caps=-all,+setuid,+setgid", "--ambient-caps=-all,+setuid,+setgid", "--", "/usr/local/bin/runner"]
