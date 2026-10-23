# Dev image for Leitor de Estudos: Rust 1.97.1, protoc 31.1, Node 22 + pnpm,
# Tauri 2 Linux deps, a C++ toolchain (code cards), Xvfb for headless runs, the PdfCraft web toolchain
# (trunk, wasm-bindgen, wasm-opt) and the Playwright browsers.
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
      xdg-utils desktop-file-utils \
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

RUN rustup component add rustfmt clippy && rustup target add wasm32-unknown-unknown

# PdfCraft web build (docs/PROJETO.md 6.1, scripts/build-pdfcraft-web.sh): trunk, wasm-bindgen-cli matching
# PdfCraft's Cargo.lock and binaryen's wasm-opt at the version trunk 0.22.0 asks for, all installed system-wide so
# `trunk build --offline` never downloads a tool. trunk is the musl build (the gnu one wants glibc 2.39).
ARG TRUNK_VERSION=0.22.0
ARG TRUNK_SHA256=7210c507cea0ee8c9296883802ce7ce50c08a38e7ed67993c2ea41ffddb89b79
ARG WASM_BINDGEN_VERSION=0.2.129
ARG BINARYEN_VERSION=131
ARG BINARYEN_SHA256=b5bf1f0eaf17c63ee588ff7a5954dc8f6ce2c26989051c66f24dfe9ece3e46db
RUN curl -fsSL -o /tmp/trunk.tar.gz \
      "https://github.com/trunk-rs/trunk/releases/download/v${TRUNK_VERSION}/trunk-x86_64-unknown-linux-musl.tar.gz" \
    && echo "${TRUNK_SHA256}  /tmp/trunk.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/trunk.tar.gz -C /usr/local/bin trunk && rm /tmp/trunk.tar.gz \
    && curl -fsSL -o /tmp/binaryen.tar.gz \
      "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-x86_64-linux.tar.gz" \
    && echo "${BINARYEN_SHA256}  /tmp/binaryen.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/binaryen.tar.gz -C /tmp "binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt" \
    && install -m 0755 "/tmp/binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt" /usr/local/bin/wasm-opt \
    && rm -rf /tmp/binaryen.tar.gz "/tmp/binaryen-version_${BINARYEN_VERSION}" \
    && wasm-opt --version | grep -q "version ${BINARYEN_VERSION}"
RUN cargo install --locked wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION} \
    && rm -rf /usr/local/cargo/registry /usr/local/cargo/git
# Pin trunk to the system tools (it would otherwise download them into ~/.cache/trunk).
ENV TRUNK_TOOLS_WASM_OPT=version_${BINARYEN_VERSION} TRUNK_TOOLS_WASM_BINDGEN=${WASM_BINDGEN_VERSION}

RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m -s /bin/bash ${USERNAME} \
    && echo "${USERNAME} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${USERNAME} \
    && mkdir -p /home/${USERNAME}/.local/share/pnpm /home/${USERNAME}/.cache /home/${USERNAME}/.config \
    && chown -R ${USERNAME}:${USERNAME} /usr/local/cargo /usr/local/rustup /home/${USERNAME}

# Playwright's Chromium and WebKit with their system libraries (e2e, mocked core and the PdfCraft bridge), at the
# version in pnpm-lock.yaml, in a shared path so runs don't download browsers. Mesa (llvmpipe) gives software WebGL
# to PdfCraft's canvas under Xvfb/headless.
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends libgl1-mesa-dri libegl1 libegl-mesa0 libgles2 \
    && npx -y playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium webkit \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" && rm -rf /var/lib/apt/lists/* /root/.npm

USER ${USERNAME}
ENV CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:/opt/protoc/bin:$PATH
