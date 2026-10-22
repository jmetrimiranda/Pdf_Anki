# pdfcraft-engine: build risk (Linux, Windows, iOS), OCR models, plan B

Pinned sources read for this doc (read-only):

| What | Where | Version |
|---|---|---|
| PdfCraft | `third_party/pdfcraft` | commit `3e968c8a`, workspace version 0.11.0, `rust-version = "1.95"`, edition 2024 |
| craft-libs (`craft-docpath`, `craft-print`) | git `storytold/craft-libs` | revs `82a24b0…` (docpath), `666c358…` (print), from `Cargo.toml:20,22` |
| winprint (Windows-only dep of craft-print) | git `storytold/winprint.rs` | rev `5f80b9b…` |
| aws-lc-sys / aws-lc-rs | crates.io | 0.45.0 / 1.18.1 in PdfCraft's `Cargo.lock:449-470`; **0.46.0 / 1.18.2 in our `src-tauri/Cargo.lock`** (it was resolved fresh, not seeded; see §1 and §3) |
| ocrs / rten | crates.io | 0.13.1 / 0.26.0 |
| boa_engine | crates.io | 0.22.0 |
| Upstream release pipeline | `storytold/craft-common-actions` `.github/workflows/release.yml` | `@main` (NOT pinned by upstream; read at d6d11df, re-checked at 1101360 on 2026-10-22: Windows job now at lines ~273-400, same content) |

All file:line references below are relative to `third_party/pdfcraft/` unless prefixed.

**Empirical check (2026-10-22):** in our devcontainer image (`leitor-dev:latest`, `rust:1.97.1-bookworm`, no cmake, no nasm installed), with the PdfCraft tree mounted read-only:
- `cargo build --locked -p pdfcraft-engine` succeeded (debug, 2m44s wall on 24 cores, ~412 crates). aws-lc-sys used the **CC builder** (`cargo:warning=Building with: CC`) with pregenerated bindings (`rustc-cfg=universal`), no cmake/bindgen/libclang.
- `cargo test --locked -p pdfcraft-ocr` with `PDFCRAFT_MODELS` pointing at freshly downloaded models: 10/10 passed, including `reads_rendered_text` (real recognition).
- Model downloads: both SHA-256 values in `ATTRIBUTION.toml` match the current S3 files.
- Our own workspace (`src-tauri`, which already path-depends on `pdfcraft-engine` via `core-pdf`) built aws-lc-sys **0.46.0** the same way: `target/debug/build/aws-lc-sys-*/output` shows `rustc-cfg=universal`, `Building with: CC`, `Symbol Prefix: Some("aws_lc_0_46_0")`, target `x86_64-unknown-linux-gnu` (verified 2026-10-22 in the `leitor-target` volume).
- Windows and iOS were NOT built (no machines); conclusions there come from source + `cargo tree --target` (re-run on our `src-tauri` lockfile: `-p pdfcraft-engine -e normal,build` = 415 unique crates on Linux, 414 on `aarch64-apple-ios`, **574 on `x86_64-pc-windows-msvc`**; `aws-lc-sys` features on all three = only `prebuilt-nasm`, no `all-bindings`/`bindgen`).

---

## 1. The single biggest build gotcha: `[patch.crates-io]`

`Cargo.toml:113-122` (PdfCraft workspace root):

```toml
[patch.crates-io]
hayro-interpret = { path = "vendor/hayro-interpret" }
hayro = { path = "vendor/hayro" }
hayro-syntax = { path = "vendor/hayro-syntax" }
hayro-cmap = { path = "vendor/hayro-cmap" }
hayro-jbig2 = { path = "vendor/hayro-jbig2" }
lopdf = { path = "vendor/lopdf" }
winit = { path = "vendor/winit" }
egui-wgpu = { path = "vendor/egui-wgpu" }
vello_common = { path = "vendor/vello_common" }
```

`[patch]` only applies from the **root** workspace. When our workspace path-depends on `pdfcraft-render`/`-engine`, these are ignored unless we repeat them. This is not just behavioural: the patches add **public API** that PdfCraft code uses, e.g. `vendor/hayro-interpret/src/interpret/mod.rs:110,113` adds `pub hide_comments: bool` and `pub ocg_overrides: Arc<Vec<(i32,i32,bool)>>` to `InterpreterSettings`, which `crates/render/src/raster.rs` sets in `RenderConfig::settings()`. Without the patch `pdfcraft-render` does not compile.

`vello_common` is needed: `hayro 0.7.1 → vello_cpu 0.0.8 → vello_common 0.0.8` (Cargo.lock:2531-2541). `winit` and `egui-wgpu` are only for PdfCraft's egui UI; do NOT copy them (we do not use winit, and an accidental match would silently patch a Tauri-side crate).

Copy into `src-tauri/Cargo.toml` (our workspace root; adjust the relative path if the root moves):

```toml
[patch.crates-io]
hayro-interpret = { path = "../third_party/pdfcraft/vendor/hayro-interpret" }
hayro           = { path = "../third_party/pdfcraft/vendor/hayro" }
hayro-syntax    = { path = "../third_party/pdfcraft/vendor/hayro-syntax" }
hayro-cmap      = { path = "../third_party/pdfcraft/vendor/hayro-cmap" }
hayro-jbig2     = { path = "../third_party/pdfcraft/vendor/hayro-jbig2" }
lopdf           = { path = "../third_party/pdfcraft/vendor/lopdf" }
vello_common    = { path = "../third_party/pdfcraft/vendor/vello_common" }
```

Vendored versions (must keep matching what the crates request): hayro 0.7.1, hayro-interpret 0.7.0, hayro-syntax 0.7.2, hayro-cmap 0.1.0, hayro-jbig2 0.3.0, lopdf 0.45.0, vello_common 0.0.8. Re-diff this block on every PdfCraft bump.

Other inheritance facts (verified):
- PdfCraft crates use `workspace = true` for versions; Cargo resolves those from the **PdfCraft** workspace root (`third_party/pdfcraft/Cargo.toml`), so path deps work as-is.
- PdfCraft's `[profile.*]` (`Cargo.toml:96-110`, e.g. `opt-level = 2` for deps in dev) is also root-only and is NOT inherited. Rendering/OCR in an unoptimised dev build is slow; set at least `[profile.dev.package."*"] opt-level = 2` in our root.
- Lockfile: our `Cargo.lock` resolves fresh versions. **Current state:** `src-tauri/Cargo.lock` already exists and was NOT seeded from PdfCraft's: it has `aws-lc-rs 1.18.2` / `aws-lc-sys 0.46.0` (PdfCraft tests 1.18.1 / 0.45.0); `reqwest 0.12.28` (Anki) and `0.13.5` (winprint build-dep, Windows only) coexist. The aws-lc-sys builder logic is unchanged between 0.45 and 0.46 (§3), and our Linux build succeeded, so this drift is acceptable; if a PdfCraft test ever disagrees with us, the way to match upstream exactly is `cargo update -p aws-lc-sys --precise 0.45.0` (and likewise for other drifted crates) rather than re-seeding. Note the exact pin `rsa = "=0.10.0-rc.18"` (`crates/sign/Cargo.toml:32`) and the pre-release RustCrypto line (sha2 0.11, p256 0.14, ecdsa 0.17); these coexist with Anki's older crypto crates, no `links` conflicts found.

---

## 2. Dependency map of `pdfcraft-engine` (what each risky crate brings)

`crates/engine/Cargo.toml:11-48` depends on 24 internal crates plus `craft-docpath`. There are **no Cargo features** in the engine or in any of the risky crates, so nothing can be switched off: taking the engine means taking sign, js, print, docpath.

| Crate | Pulls | Native code? | Build tools needed |
|---|---|---|---|
| `craft-docpath` (`craft-libs` rev 82a24b0, `crates/docpath`) | nothing (no deps) | no | git network access to github.com at fetch time |
| `pdfcraft-sign` (`crates/sign/Cargo.toml`) | `aws-lc-rs 1.18` with `default-features=false, features=["aws-lc-sys","prebuilt-nasm"]` (line 44, non-wasm), `getrandom` (45); Windows: `rustls-cng 0.7.1` (49); macOS only: `security-framework 3.7` (53) | **yes**: aws-lc-sys compiles AWS-LC C + asm | C compiler (gcc/clang on Linux, MSVC `cl.exe` on Windows, Xcode clang on Apple). No cmake, no nasm, no libclang in the default path (see §3) |
| `pdfcraft-js` (`crates/js/Cargo.toml:14`) | `boa_engine 0.22.0`, `default-features=false, features=["annex-b"]` | no (pure Rust; `intl`/ICU features off) | none; adds noticeable compile time |
| `pdfcraft-print` (`crates/print/Cargo.toml:12`) | `craft-print` (rev 666c358). Linux/macOS: **no deps**, shells out to CUPS CLI at runtime. Windows: `winprint` (git), `winsafe 0.0.29`, `tempfile`, `roxmltree`, `miniz_oxide` | Windows: links system Win32/WinRT only | Linux: none at build time. Windows: see winprint build-deps below |
| `pdfcraft-ocr` (`crates/ocr/Cargo.toml:15-16`) | `ocrs 0.13.1` (`default-features=false, features=["rten"]`), `rten 0.26.0` (`default-features=false, features=["rten_format"]`) | no (pure Rust, rayon) | none; needs the two `.rten` model files at **runtime** |

### craft-print details (rev 666c358, `crates/print/src/lib.rs`)
- Doc comment lines 1-3: "On macOS and Linux this is CUPS: printers come from `lpstat` … `lp` with the job options".
- `printers()` (line 359) runs `lpstat -p -d` and `lpstat -e` via `std::process::Command` under `#[cfg(all(unix, not(target_arch = "wasm32")))]` (360); failures are swallowed (`.output().ok()`), so with no CUPS you get an empty list.
- `submit_with_progress` (453) spawns `lp` (457) and feeds the PDF on stdin.
- `printer_options` (263) reads `/etc/cups/ppd/{printer}.ppd` and runs `lpoptions` (271-277).
- So on Linux: **no `libcups2-dev` needed**; runtime-only `cups-client` (provides `lp`, `lpstat`, `lpoptions`). Upstream's deb lists it as `recommends`, not `depends` (`packaging/linux/nfpm.yaml:28-39`; comment at :22-26: the binaries link only glibc and libgcc_s).
- iOS is `cfg(unix)`: it compiles; `Command` spawn fails under the iOS sandbox and `printers()` returns empty. Not a build blocker.

### winprint (Windows only) — hidden heavy build-dependency
`winprint` rev 5f80b9b `Cargo.toml`:
```toml
[build-dependencies]
reqwest = { version = "0.13", features = ["blocking"] }
flate2 = "1.1"
tar = "0.4"
sigstore-trust-root = { version = "0.6.5", default-features = false }
sigstore-types = "0.6.5"
sigstore-verify = { version = "0.6.5", default-features = false }
[features]
default = ["pdfium"]
```
craft-print uses it with `default-features = false`, so `build.rs` `main()` does nothing (`#[cfg(feature = "pdfium")] try_link_pdfium()` is compiled out; no network at build). But the build-deps are still **compiled for the host** on Windows: reqwest 0.13.5 → rustls 0.23.46 (feature `aws_lc_rs`) → a second host build of aws-lc-sys, plus ring 0.17.14, tokio, hyper, quinn, sigstore-* (`cargo tree --target x86_64-pc-windows-msvc` confirms). rustls' `aws_lc_rs` feature enables `aws-lc-rs/prebuilt-nasm` (rustls-0.23.46 `Cargo.toml:58-62`), so this host build also needs no NASM. Cost: Windows compile time, not new tools.

---

## 3. aws-lc-sys 0.45.0: exactly which builder runs and what it needs

Source: `aws-lc-sys-0.45.0/builder/main.rs` (PdfCraft's lock). Line numbers below are for 0.45.0; in **0.46.0 (our lock)** the same functions are at `get_builder` main.rs:704, `is_bindgen_required` :925, `use_prebuilt_nasm` :1150, `CcBuilder::check_dependencies` cc_builder.rs:1103. `diff -r` of the two `builder/` dirs shows no change to builder selection, bindgen requirement, prebuilt-NASM or the all-bindings target list; 0.46 only drops the `universal_prefixed`/`universal_no_u1` binding variants (always emits `universal`), adds `binding_names.rs` (strips link prefixes from generated bindings), and stops canonicalising `CARGO_MANIFEST_DIR` on non-Windows hosts (reproducibility).

Builder selection, `fn get_builder` (main.rs:725-812):
1. If `AWS_LC_SYS_SYSTEM_DIR` is set, or a system AWS-LC is auto-detected → link it (we have none).
2. FIPS → CMake (not us).
3. `AWS_LC_SYS_CMAKE_BUILDER=1/0` forces CMake/CC.
4. `AWS_LC_SYS_NO_ASM` or a sanitizer → CMake.
5. Otherwise, if `!is_bindgen_required()` → **CcBuilder** (just the `cc` crate + a C compiler). Falls back to CMake only if CcBuilder's `check_dependencies` fails.

`is_bindgen_required()` (main.rs:969-980) is false when pregenerated bindings exist. With `aws-lc-sys` default features OFF (aws-lc-rs depends on it with `default-features = false`, aws-lc-rs-1.18.1 `Cargo.toml:110-113`; `all-bindings` only comes via aws-lc-rs `legacy-des`), the crate uses its universal pregenerated bindings for any target (main.rs:942-965). In 0.45.0 the exact cfg is target-dependent: `universal_prefixed` for `target_vendor == "apple"` (so **iOS/macOS**) and 32-bit Windows x86, `universal_no_u1[_prefixed]` for mips or the Cranelift backend, `universal` otherwise (main.rs:388-407, 944-961); 0.46.0 always emits `universal`. Either way no bindgen/libclang. With `all-bindings` ON, the target-specific list is (main.rs:913-934): `aarch64-apple-darwin, aarch64-unknown-linux-gnu/musl, x86_64-apple-darwin, x86_64-unknown-linux-gnu/musl, aarch64-linux-android, aarch64/i686/x86_64-pc-windows-msvc, x86_64-pc-windows-gnu, i686/riscv64 linux` — **no iOS**; if anything in our graph ever enables `aws-lc-sys/all-bindings` (or `bindgen`), iOS would need bindgen + libclang. Check with `cargo tree -e features -i aws-lc-sys` after adding Tauri plugins.

`CcBuilder::check_dependencies` (cc_builder.rs:1086-1101) only rejects dynamic builds, OpenHarmony and the `ssl` feature: no tool probe.

NASM on Windows x86_64: `use_prebuilt_nasm()` (main.rs:1186-1195) returns true when target is windows/x86_64, `nasm` is not on PATH, and either the `prebuilt-nasm` feature or `AWS_LC_SYS_PREBUILT_NASM=1` is set. `pdfcraft-sign` enables the feature (`crates/sign/Cargo.toml:44`), so the crate's shipped prebuilt NASM objects (`builder/prebuilt-nasm/`) are used. Installing NASM is optional (only needed for `OPENSSL_SMALL` size builds, cc_builder.rs:648-656).

Windows ARM64 (`aarch64-pc-windows-msvc`): CcBuilder wants `clang-cl` (cc_builder.rs:1104-1118; "Install the 'C++ Clang Compiler for Windows' component"). Not our target now.

Windows long paths: main.rs:~690-715 converts paths to 8.3 short names and warns when a path exceeds MAX_PATH. Keep `CARGO_TARGET_DIR` short on Windows CI (e.g. `C:\t`) as cheap insurance.

iOS: `cmake_builder.rs:306-308` has iOS handling, and `cc_builder.rs:63-70` picks `apple_aarch64` sources for any `target_vendor == "apple"`, so `aarch64-apple-ios` should go through CcBuilder with Xcode clang + universal bindings. **Not built/verified** (needs a Mac). aws-lc-rs is widely used on iOS via rustls, so risk is moderate-low.

Useful env knobs (all prefixed `AWS_LC_SYS_`, optionally suffixed with the target triple with `_`): `CMAKE_BUILDER`, `PREBUILT_NASM`, `NO_ASM`, `SYSTEM_DIR`, `USE_SYSTEM`, `C_STD`, `CFLAGS`.

---

## 4. System libraries / tools to install

### Debian bookworm (our devcontainer)
For the PdfCraft engine itself (verified by the build above):

| Need | Package | Why |
|---|---|---|
| C compiler + `ar` | `build-essential` (gcc 12) | aws-lc-sys (CcBuilder), any `cc`-crate build |
| git | `git` | cargo git deps (`craft-libs`) |
| curl, sha256sum | `curl`, `coreutils` | OCR model fetch (`scripts/fetch-ocr-models.sh`) |
| (runtime, optional) | `cups-client` | printing via `lp`/`lpstat`; only if we expose printing |

NOT needed: `cmake`, `nasm`, `clang`/`libclang-dev`, `perl`, `golang`, `libcups2-dev`, `pkg-config` (aws-lc-sys lists pkg-config as a build-dep crate only for optional system-library detection). Our `.devcontainer/Dockerfile` already has all required items (it installs `build-essential git curl` plus Tauri/Anki deps). The egui/winit libs upstream CI installs (`.github/workflows/ci.yml:51-58`: `libxkbcommon-dev libwayland-dev libx11-dev libxrandr-dev libxi-dev libgl1-mesa-dev libgtk-3-dev qpdf poppler-utils`) are for their egui app and test oracles, not for the engine.

### GitHub `windows-latest`
| Need | Source |
|---|---|
| MSVC toolchain (`cl.exe`, `link.exe`) + Windows SDK | preinstalled (Visual Studio 2022 Build Tools on the image) |
| Rust `x86_64-pc-windows-msvc` | `dtolnay/rust-toolchain` (or rustup with our `rust-toolchain.toml`, 1.97.1) |
| git, curl | preinstalled (`curl.exe` ships with Windows 10+; upstream's `xtask models` relies on it, `xtask/src/assets.rs:311,331`) |
| NASM | not needed (prebuilt-nasm, §3) |
| CMake / LLVM | not needed for x64 (preinstalled on the image anyway) |

Evidence: upstream CI `ci.yml:31` runs `cargo clippy --workspace --all-targets` and `cargo test --workspace` on `windows-latest` with **no** tool-install step for Windows (only `PDFCRAFT_REQUIRE_WINRES=1`, lines 72-75), and the shared release workflow (`craft-common-actions/.github/workflows/release.yml:257-370`) builds x64, x86 and arm64 MSVC on `windows-latest` installing only the Rust target and WiX.

### iOS (later, on macOS)
Xcode + `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`. Nothing else expected (aws-lc-sys CcBuilder with Xcode clang; boa/ocrs/rten/hayro are pure Rust; `security-framework` is gated to `target_os = "macos"` only, `crates/sign/Cargo.toml:51-53`; `rustls-cng` to Windows). `cargo tree --target aarch64-apple-ios -p pdfcraft-engine` shows the only native pieces are `aws-lc-sys` and `core-foundation-sys`. Unverified until Phase 0 on a Mac.

---

## 5. OCR models

### Manifest (source of truth): `ATTRIBUTION.toml:3361-3385`
| File | URL | SHA-256 | Size (2026-10-22) |
|---|---|---|---|
| `text-detection.rten` | `https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten` | `f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca` | 2,510,284 B |
| `text-recognition.rten` | `https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten` | `e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e` | 9,716,568 B |
| licence (both) | `https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt` | `28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5` | 20,138 B |

Licence: CC-BY-SA-4.0, author Robert Knight (ocrs-models, trained on HierText). Attribution must ship with the models.

### How `cargo xtask models` does it
- Registered at `xtask/src/main.rs:42`; implemented in `xtask/src/assets.rs:347-356` (`models`), `312-323` (`fetch_all`), `325-342` (`fetch_verified`).
- For every `[[fetched]]` with `kind = "model"`: skip if the file already has the right hash; otherwise `curl -sSfL --retry 3 -o <tmp> <url>`, verify SHA-256, rename. (`<tmp>` is `path.with_extension("part")`, assets.rs:330, i.e. `text-detection.part`, not `text-detection.rten.part`; our script below uses `<file>.part`, which is harmless.) Also fetches `<file>.LICENCE.txt` from `licence_url` (verified by `licence_sha256`), then writes `ATTRIBUTION.txt` (text from `models_attribution`, assets.rs:359-369).
- Default destination `assets/models/` (git-ignored); packaging passes a dir: `packaging/env.sh:87-98` (`stage_models`), `packaging/windows/package.ps1:99-108`.

### Where the runtime looks (`crates/ocr/src/lib.rs`)
```rust
// lib.rs:18-19
pub const DETECTION_MODEL: &str = "text-detection.rten";
pub const RECOGNITION_MODEL: &str = "text-recognition.rten";
// lib.rs:52
pub fn in_dir(dir: &Path) -> Option<Models>
// lib.rs:59
pub fn find() -> Option<Models>
// lib.rs:64  order: $PDFCRAFT_MODELS, then dirs_beside_exe(exe dir), then
//            env!("CARGO_MANIFEST_DIR")/../../assets/models (compile-time path!)
pub fn search_dirs() -> Vec<PathBuf>
// lib.rs:82  [exe/models, exe/../Resources/models, exe/../share/pdfcraft/models]
pub fn dirs_beside_exe(exe_dir: &Path) -> Vec<PathBuf>
```
Gotchas:
- None of these matches Tauri's resource dir on Linux deb (`/usr/lib/<app>/…`) or iOS bundles. **Do not rely on `Models::find()` / `Ocr::find()` / `pdfcraft_engine::ocr::engine()` / `Session::recognize_text`** (they all go through `find`). Resolve the dir ourselves (Tauri `app.path().resource_dir()?.join("models")`) and call `Models::in_dir` + `Ocr::load`.
- Setting `PDFCRAFT_MODELS` from inside the app needs `std::env::set_var`, which is `unsafe` in edition 2024 and racy with threads; avoid it. Use it only in dev shells/tests.
- `search_dirs` bakes the build machine's path (`CARGO_MANIFEST_DIR`) into the binary: harmless, but it means dev builds "just work" if models are in `third_party/pdfcraft/assets/models` — do not put them there (we must not modify `third_party/`); use our own dir.
- Models read only the Latin alphabet without accents (`ALPHABET`, lib.rs:24; `LANGUAGES = [("en","English")]`, lib.rs:27). Portuguese accents will be lost/misread.
- Only the `.rten` format loads: `pdfcraft-ocr` enables `ocrs` with `default-features = false, features = ["rten"]` and `rten` with only `rten_format` (`crates/ocr/Cargo.toml:15-16`), so ocrs' default `onnx` feature (`rten/onnx_format`, ocrs-0.13.1 `Cargo.toml` `[features]`) is off. Do not try to drop in `.onnx` models.
- `Ocr::load` uses `rten::Model::load_file` (lib.rs:113) for each file; errors come back as `OcrError::Load(path, msg)`.

### OCR API (words + rects)
```rust
// crates/ocr/src/lib.rs
pub struct Models { pub detection: PathBuf, pub recognition: PathBuf }          // :45-48
pub struct Word { pub text: String, pub rect: [f32; 4] }                         // :89-92  [left, top, right, bottom] in IMAGE PIXELS
pub struct Line { pub words: Vec<Word> }                                         // :96-98  reading order
impl Line { pub fn text(&self) -> String }                                       // :101
pub struct Ocr { /* ocrs::OcrEngine */ }                                         // :107  Send + Sync (engine keeps it in a static Mutex<Option<Arc<Ocr>>>)
impl Ocr {
    pub fn load(models: &Models) -> Result<Ocr, OcrError>                        // :112  slow (~model load); keep one and reuse
    pub fn find() -> Result<Ocr, OcrError>                                       // :125
    pub fn recognize(&self, pixels: &[u8], width: u32, height: u32) -> Result<Vec<Line>, OcrError> // :130
}
pub enum OcrError { NoModels, Load(String, String), Recognize(String), EmptyImage } // :30-41
pub struct PlacedWord { pub text: String, pub origin: [f64;2], pub across: [f64;2], pub up: [f64;2] } // :168-173 PDF user space
impl PlacedWord { pub fn place(word: &Word, to_user: impl Fn(f32, f32) -> [f64; 2]) -> PlacedWord } // :178
pub fn text_layer(words: &[PlacedWord]) -> Vec<u8>                               // :217  invisible-text content stream (/PCHelv)
```
`recognize` input: if `pixels.len() == w*h*4` it is treated as RGBA and alpha is dropped (lib.rs:135-137); otherwise passed to `ocrs::ImageSource::from_bytes`, which infers 1 or 3 channels from `len / (w*h)`. Render output is premultiplied RGBA8 on an opaque white page (`RenderedPage::rgba`, `crates/render/src/raster.rs:203-218`), so it can be passed straight in.

Minimal "OCR one page → words with page-point rects" (our `ocr_page`), using only render + ocr; this mirrors `OcrJob::run` (`crates/engine/src/ocr.rs:107-152`):
```rust
use std::sync::Arc;
use pdfcraft_render::{inspect, PageRenderer, RenderConfig, RenderRequest};
use pdfcraft_ocr::{Models, Ocr};

let ocr = Ocr::load(&Models::in_dir(&models_dir).ok_or("models missing")?)?;     // once per app
let bytes: Arc<Vec<u8>> = Arc::new(std::fs::read(path)?);
let info = inspect(bytes.clone(), None)?;                                         // render/src/inspect.rs:515
let page_info = &info.pages[page];                                                // PageInfo: width/height in points, view space y-down
let mut r = PageRenderer::new(bytes, RenderConfig::default());                    // raster.rs:431
let scale = 300.0 / 72.0;                                                         // engine default dpi 300 (ocr.rs:54), clamped 72..600
let shot = r.render(RenderRequest { page, scale, ..Default::default() });         // raster.rs:455, never panics
if let Some(e) = shot.error { return Err(e.into()); }
let lines = ocr.recognize(&shot.rgba, shot.width, shot.height)?;                  // Pixels: Deref<Target=[u8]>
let px_per_pt = shot.width as f32 / page_info.width.max(1e-3);
for w in lines.iter().flat_map(|l| &l.words) {
    let rect_pt = w.rect.map(|v| v / px_per_pt);   // [x0,y0,x1,y1] in page VIEW space (points, top-left origin) — same space as TextGlyph::rect
    // to PDF user space if needed: page_info.view_to_user(x, y)  (inspect.rs:201)
}
```
The engine additionally (a) skips pages that already have text (`RequestKind::Text` render first, ocr.rs:119-127), (b) renders scans at their native image resolution (`OcrJob::scale`, ocr.rs:155-165; `OcrJob`'s fields `bytes/password/infos/native` are private, so an `OcrJob` can only be built by `Session::ocr_job`), (c) drops words ≥50% covered by existing glyphs (`ALREADY_ON_PAGE`, ocr.rs:31,146-147; `covered()` at :40 is private, ~10 lines to copy). Replicate (a) and (c) in plan B; (b) is an optimisation and IS replicable without the engine: `Session::ocr_job` computes `native` (ocr.rs:174-189) from `pdfcraft_edit::page_images(doc: &Document, page: usize) -> Result<Vec<PageImage>, EditError>` (`crates/edit/src/images.rs:234`, re-exported at edit/src/lib.rs:990), using public `PageImage { width: u32, height: u32, matrix: [f64; 6], .. }` (images.rs:15-33): `native = max over images with width>1 && height>1 of max(width/hypot(m0,m1), height/hypot(m2,m3))`, then `native.clamp(fit, wanted*fit)` with `fit = min(842/max(page w,h), 1)`.

### `scripts/fetch-ocr-models.sh` (replicates `cargo xtask models`, incl. licence + ATTRIBUTION.txt)
```bash
#!/usr/bin/env bash
# Fetch the PdfCraft OCR models (ocrs, CC-BY-SA-4.0) verified by SHA-256.
# Mirrors `cargo xtask models` (third_party/pdfcraft/xtask/src/assets.rs:312-369) and the
# [[fetched]] kind="model" entries of third_party/pdfcraft/ATTRIBUTION.toml:3361-3385.
# Usage: scripts/fetch-ocr-models.sh [DEST]   (default: src-tauri/resources/models)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/src-tauri/resources/models}"
mkdir -p "$DEST"

LICENCE_URL="https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt"
LICENCE_SHA="28a9529c7d0bb4dc51f4bf5c116a3d16ef247a052f7591466768ddf563fd1cf5"
MODELS=(
  "text-detection.rten|https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten|f15cfb56bd02c4bf478a20343986504a1f01e1665c2b3a0ad66340f054b1b5ca"
  "text-recognition.rten|https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten|e484866d4cce403175bd8d00b128feb08ab42e208de30e42cd9889d8f1735a6e"
)

sha() { sha256sum "$1" | cut -d' ' -f1; }   # macOS: shasum -a 256

fetch_verified() { # url path sha
  local url="$1" path="$2" want="$3"
  if [ -f "$path" ] && [ "$(sha "$path")" = "$want" ]; then return 0; fi
  echo "fetching $url"
  curl -sSfL --retry 3 -o "$path.part" "$url"
  if [ "$(sha "$path.part")" != "$want" ]; then
    rm -f "$path.part"; echo "error: $url: SHA-256 mismatch (expected $want)" >&2; exit 1
  fi
  mv "$path.part" "$path"
}

for m in "${MODELS[@]}"; do
  IFS='|' read -r file url want <<<"$m"
  fetch_verified "$url" "$DEST/$file" "$want"
  fetch_verified "$LICENCE_URL" "$DEST/$file.LICENCE.txt" "$LICENCE_SHA"
done

cat > "$DEST/ATTRIBUTION.txt" <<'EOF'
Leitor de Estudos' text recognition (OCR, via PdfCraft's pdfcraft-ocr and ocrs) uses these models, unmodified.

text-detection.rten
  Ocrs text detection model
  by Robert Knight (ocrs-models; trained on HierText, CC-BY-SA-4.0)
  from https://github.com/robertknight/ocrs-models (the models ocrs downloads; model card: https://huggingface.co/robertknight/ocrs, cc-by-sa-4.0)
  licence: CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt; full text in text-detection.rten.LICENCE.txt)

text-recognition.rten
  Ocrs text recognition model
  by Robert Knight (ocrs-models; trained on HierText, CC-BY-SA-4.0)
  from https://github.com/robertknight/ocrs-models (the models ocrs downloads; model card: https://huggingface.co/robertknight/ocrs, cc-by-sa-4.0)
  licence: CC-BY-SA-4.0 (https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt; full text in text-recognition.rten.LICENCE.txt)
EOF
rm -f "$DEST"/*.part
ls -l "$DEST"
```
Windows CI equivalent: run the same script under Git Bash (`shell: bash` on `windows-latest` has `curl` and `sha256sum`). On each PdfCraft bump, diff `ATTRIBUTION.toml` `kind = "model"` entries against this script (upstream intentionally never names model files in packaging, `packaging/env.sh:82-86`). Gitignore the destination; bundle it as a Tauri resource (`bundle.resources`), ~12 MB.

---

## 6. How upstream builds (for reference)

- CI (`.github/workflows/ci.yml`): matrix `ubuntu-latest`, `windows-latest` (line 31), stable Rust, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace`. Linux installs only GUI libs + oracles (51-58). Optional `CRAFT_FONTS_DIR` (Japanese fonts; `crates/fonts/build.rs:11-20` — unset means "build without", only a warning).
- Release (`release.yml` → `craft-common-actions/.github/workflows/release.yml@main`): Linux on `ubuntu-22.04` (+ `-arm`) via `packaging/linux/package.sh` (`cargo build --release --locked -p pdfcraft -p pdfcraft-cli`, line 57-59; models to `usr/share/pdfcraft/models`, line 81). Windows x64/x86/arm64 on `windows-latest` via `packaging/windows/package.ps1` (line 65; models to `models\` beside the exe, 99-108). Linux deps action installs only `libxkbcommon-dev libwayland-dev libx11-dev libxrandr-dev libxi-dev libgl1-mesa-dev libasound2-dev pkg-config` + packaging tools.
- Other upstream workflows (`.github/workflows/`): `windows-arm64.yml` (calls `craft-common-actions/.github/workflows/windows-arm64.yml@main`: cross-compiles the ARM64 MSI on an x64 runner, then installs/tests it on a Windows 11 ARM64 runner; aws-lc-sys there needs `clang-cl`, which the `windows-latest` image ships), `freebsd.yml`, `nix.yml`, `packaging-lint.yml`, `sonarcloud.yml`. CI also runs a `wasm32` check job (`ci.yml:106-119`, `cargo xtask wasm`) and `cargo deny`.
- Upstream has **no iOS target** at all (macOS is built only in the release workflow, `macos-15-xlarge`).

---

## 7. Plan B: render + annot + ocr + cos (no engine)

Verified with `cargo tree --locked -e normal,build`:

| Crate | Internal deps | Unique deps | Native/C | Git deps |
|---|---|---|---|---|
| `pdfcraft-cos` | crypt, filters | ~42 | none | none |
| `pdfcraft-render` | cos, fonts (+ hayro/lopdf vendored) | ~161 | none | none |
| `pdfcraft-annot` | cos, fonts, model | ~58 | none | none |
| `pdfcraft-ocr` | fonts (→ cos) (+ ocrs, rten) | ~87 | none | none |
| `pdfcraft-edit` (optional, to write the OCR layer) | annot, content, cos, fonts, model | ~65 | none | none |
| `pdfcraft-engine` (for comparison) | 24 crates | ~412 | aws-lc-sys (+ ring/aws-lc host build on Windows) | craft-libs ×2, winprint (Windows) |

Plan B removes **all** C code, both git repos, boa, and the Windows reqwest/sigstore build-dep chain. It still needs the `[patch.crates-io]` block (§1). It still runs `crates/fonts/build.rs` (every plan-B crate depends on `pdfcraft-fonts`): with `CRAFT_FONTS_DIR` unset it embeds nothing, silently; set-but-broken prints a warning, or a hard error if `CRAFT_FONTS_REQUIRED` is also set (build.rs:11-22). Without craft-fonts, non-embedded Adobe-Japan1 CID fonts fall back to hayro's Latin standard-14 substitutes (render `japanese_fallback`, raster.rs:93), so such text may render blank — irrelevant for our PT/EN material.

Useful plan-B entry points (exact signatures):
```rust
// pdfcraft-cos (crates/cos/src/document.rs, writer.rs)
pub fn open(data: Arc<Vec<u8>>) -> Result<Self, CosError>                                     // Document::open, document.rs:571
pub fn open_with_password(data: Arc<Vec<u8>>, password: Option<&str>) -> Result<Self, CosError> // document.rs:577
pub fn write_incremental(doc: &Document, opts: &SaveOptions) -> Result<Vec<u8>, CosError>      // writer.rs:189
pub fn write_full(doc: &Document, opts: &SaveOptions) -> Result<Vec<u8>, CosError>             // writer.rs:254
pub struct SaveOptions { pub mod_date: Option<String>, pub id_seed: u64, pub object_streams: bool } // writer.rs:151, Default impl :161
// pdfcraft-annot (crates/annot/src/lib.rs)
pub fn add_annotation(doc: &mut Document, new: &NewAnnotation, meta: &Meta) -> Result<usize, AnnotError> // lib.rs:1073
// pdfcraft-edit (crates/edit/src/lib.rs) — how the engine writes the OCR layer
pub fn stamp(doc: &mut Document, page: usize, tag: &str, content: Vec<u8>) -> Result<(), EditError>   // lib.rs:667
//   engine usage: pdfcraft_edit::stamp(doc, page, "OCR", pdfcraft_ocr::text_layer(words))  (engine/src/lib.rs:2637)
// pdfcraft-render: PageRenderer::new / render, RenderPool::new(bytes, threads, config) (raster.rs:741), inspect (inspect.rs:515)
```

### What we lose without `pdfcraft-engine`
Engine modules (`crates/engine/src/lib.rs:15-42`) and what they give:
- `Session` façade: open/close by `DocId`, edit list with **undo/redo**, incremental save with post-save verification (`save_bytes` + `check_save`, used in `ocr.rs:252-253`), read-only reasons. We would hold `pdfcraft_cos::Document` ourselves and re-open after save (`Document::reopen_after_save`, document.rs:1401).
- OCR orchestration: `OcrSettings`, `OcrJob`, `Session::ocr_job/apply_ocr/recognize_text`, `recognize_file` (`ocr.rs:18,93,170,194,205,233`): text-page skipping, native-resolution scaling, de-dup against existing text, one undoable `Edit::AddOcrText`. ~150 lines to replicate (snippet in §5).
- Not needed for v1 but lost: digital signatures (`pdfcraft_sign`, `engine/src/lib.rs:161`, `signature_image.rs`), Acrobat JavaScript form calc (`js.rs`, `xfa.rs`), printing/imposition (`pdfcraft_print`, lib.rs:155, `print_raster.rs`), forms fill, XFA, redaction, optimise, export (images/TIFF), compare, preflight, accessibility/autotag, measure, create-from-images, word count, camera/scan cleanup, link target safety (`links.rs` with `craft_docpath`, lines 141-197), the command/tool catalogue (`commands.rs`, `catalog.rs`).
- Since the spec stores annotations in our DB and only "Export annotated PDF" writes into a copy, v1 needs: render (pixels + `PageText`), annot (export), ocr, cos (open/save), optionally edit (persist OCR layer). All in plan B.

---

## 8. Recommendations

1. **Desktop (Linux, Windows): use `pdfcraft-engine`.** It builds cleanly on bookworm with only `build-essential` (verified), and upstream builds it on `windows-latest` with no extra tools. No cmake/nasm/libclang/CUPS-dev to install.
2. **Hide the engine behind a cargo feature in `core-pdf`** (e.g. `engine` default-on for desktop, off for iOS), and write `core-pdf`'s OCR/render paths against `pdfcraft-render` + `pdfcraft-ocr` directly (the engine re-exports them anyway). Then plan B is a feature flip, not a rewrite, and iOS Phase 0 can try both.
3. **Always copy the 7-entry `[patch.crates-io]` block** (§1) and an optimised dev profile for deps (both already present in `src-tauri/Cargo.toml`). Our `Cargo.lock` was resolved fresh (aws-lc-sys 0.46.0 vs upstream 0.45.0); keep it, and pin individual crates with `cargo update -p <crate> --precise <upstream version>` only if a divergence causes trouble.
4. **Never use `Models::find()`-based APIs in the app**; load with `Models::in_dir(resource_dir/models)` + `Ocr::load`, keep one `Arc<Ocr>`, run `OcrJob::run`/`recognize` on a worker thread (≈1 s/page per upstream docs, `engine/src/ocr.rs:4`). If using the engine, `Session::ocr_job` + `OcrJob::run(&our_ocr, …)` + `Session::apply_ocr` works without `find()`.
5. CI: Linux job = our devcontainer image; Windows job = `windows-latest`, `shell: bash` for `scripts/fetch-ocr-models.sh`, short `CARGO_TARGET_DIR`, cache with `Swatinem/rust-cache`. Expect a long first Windows build (aws-lc twice + reqwest/tokio/sigstore build-deps from winprint).
6. iOS Phase 0: first `cargo build --target aarch64-apple-ios -p pdfcraft-render -p pdfcraft-ocr -p pdfcraft-annot -p pdfcraft-cos` (pure Rust, should just work), then `-p pdfcraft-engine` (risk concentrated in aws-lc-sys via CcBuilder; check `cargo tree -e features -i aws-lc-sys` shows no `all-bindings`/`bindgen`).
7. Accept the OCR language limitation (Latin, no accents) or plan a different OCR for Portuguese; it is a model limitation, not a build one.

## 9. Not found / unverified
- No Windows or iOS build was executed; Windows conclusions rest on upstream CI + source, iOS on source + `cargo tree` only.
- `craft-common-actions` workflows are referenced by upstream at `@main` (unpinned); what I read is today's version, not necessarily the one that produced PdfCraft's last release.
- The colleague's original empirical PdfCraft-workspace build (`cargo build --locked -p pdfcraft-engine` with aws-lc-sys 0.45.0) could not be re-traced: the shared `leitor-cargo-registry` volume holds only aws-lc-sys 0.46.0, so that run used a different `CARGO_HOME`. The 0.46.0 build of our own workspace (§0) is the evidence that matters.
- I did not find an upstream statement of OCR throughput beyond the "about a second a page" comment (`crates/engine/src/ocr.rs:4`).
