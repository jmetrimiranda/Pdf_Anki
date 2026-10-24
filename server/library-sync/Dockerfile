# Leitor de Estudos library sync server (spec 16, docs/planos/fase-9a.md). Build context: server/library-sync.
#   docker build -t leitor-library-sync server/library-sync
# Runs as an unprivileged user; data in /data (a named volume: library.sqlite + files/). No curl in the image: the
# healthcheck is the binary itself.
FROM rust:1.97.1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked --bin library-sync

FROM debian:bookworm-slim
RUN groupadd --gid 10010 library \
    && useradd --uid 10010 --gid 10010 --no-create-home --home-dir /data --shell /usr/sbin/nologin library \
    && mkdir -p /data \
    && chown library:library /data
COPY --from=build /src/target/release/library-sync /usr/local/bin/library-sync
USER library
ENV LIBRARY_SYNC_DATA=/data LIBRARY_SYNC_PORT=8090
VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 CMD ["/usr/local/bin/library-sync", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/library-sync"]
