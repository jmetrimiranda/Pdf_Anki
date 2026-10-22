# Dev image for Leitor de Estudos: Rust 1.97.1, protoc 31.1, Node 22 + pnpm,
# Tauri 2 Linux deps, a C++ toolchain (code cards) and Xvfb for headless runs.
FROM rust:1.97.1-bookworm

ARG USERNAME=dev
ARG USER_UID=1000
ARG USER_GID=1000
ARG PROTOC_VERSION=31.1
ARG NODE_MAJOR=22

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config curl wget file unzip xz-utils git ca-certificates sudo \
      libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libgtk-3-dev \
      librsvg2-dev libayatana-appindicator3-dev libssl-dev libxdo-dev \
      xvfb xauth dbus-x11 at-spi2-core imagemagick fonts-noto-core fonts-dejavu \
      g++ clang clang-format python3 python3-venv \
      gnome-keyring libsecret-1-dev \
    && rm -rf /var/lib/apt/lists/*

# protoc pinned to the version Anki 26.09.3 uses.
RUN curl -fsSL -o /tmp/protoc.zip \
      "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip" \
    && unzip -q /tmp/protoc.zip -d /opt/protoc && rm /tmp/protoc.zip \
    && chmod -R a+rX /opt/protoc
ENV PROTOC=/opt/protoc/bin/protoc PROTOC_INCLUDE=/opt/protoc/include

ENV COREPACK_HOME=/opt/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable && corepack prepare pnpm@10.34.7 --activate \
    && chmod -R a+rwX /opt/corepack

RUN rustup component add rustfmt clippy

RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && mkdir -p /home/${USERNAME}/.local/share/pnpm /home/${USERNAME}/.cache /home/${USERNAME}/.config \
    && chown -R ${USERNAME}:${USERNAME} /usr/local/cargo /usr/local/rustup /home/${USERNAME}

# System libraries for Playwright's Chromium and WebKit (e2e against the mocked core).
RUN npx -y playwright@1.64.1 install-deps chromium webkit && rm -rf /var/lib/apt/lists/*

USER ${USERNAME}
ENV CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:/opt/protoc/bin:$PATH
