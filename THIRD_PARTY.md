# Third-party licences

KVGrainy is licensed under the GNU Affero General Public License v3.0 (see `LICENSE`).

This file lists the Rust crates compiled into `kvgrainy-core` and `kvgrainy-cli` (the runtime
dependency closure, all targets, with default features). It is generated from `cargo metadata`;
regenerate it with `python scripts/third_party.py > THIRD_PARTY.md` after changing dependencies.

## Compatibility notes

- Every licence below is compatible with distributing the combined work under AGPL-3.0.
- **MPL-2.0** (`avif-parse`): file-level copyleft, used unmodified; MPL-2.0 permits combination with AGPL-3.0.
- **`r-efi`** is offered under `MIT OR Apache-2.0 OR LGPL-2.1-or-later`; KVGrainy uses it under MIT.
- **mozjpeg** (`IJG AND Zlib AND BSD-3-Clause`) and **libwebp** (BSD-3-Clause) are C libraries built from source by their `-sys` crates on native targets only.
- Not yet included: the Tauri shell, the web app's npm packages, and any bundled ffmpeg. Add them here when they ship (ffmpeg builds must be LGPL-configured or the combination documented).

## Crates

| Crate | Version | Licence |
|---|---|---|
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 |
| aligned | 0.4.3 | MIT OR Apache-2.0 |
| aligned-vec | 0.6.4 | MIT |
| anstream | 1.0.0 | MIT OR Apache-2.0 |
| anstyle | 1.0.14 | MIT OR Apache-2.0 |
| anstyle-parse | 1.0.0 | MIT OR Apache-2.0 |
| anstyle-query | 1.1.5 | MIT OR Apache-2.0 |
| anstyle-wincon | 3.0.11 | MIT OR Apache-2.0 |
| anyhow | 1.0.104 | MIT OR Apache-2.0 |
| aom-decode | 0.2.14 | BSD-2-Clause |
| arbitrary | 1.4.2 | MIT OR Apache-2.0 |
| arg_enum_proc_macro | 0.3.4 | MIT |
| arrayvec | 0.7.8 | MIT OR Apache-2.0 |
| as-slice | 0.2.1 | MIT OR Apache-2.0 |
| av-data | 0.4.4 | MIT |
| av-scenechange | 0.14.1 | MIT |
| av1-grain | 0.2.5 | BSD-2-Clause |
| avif-decode | 1.0.2 | BSD-3-Clause |
| avif-parse | 1.4.0 | MPL-2.0 |
| avif-parse | 2.1.0 | MPL-2.0 |
| avif-serialize | 0.8.9 | BSD-3-Clause |
| bitflags | 2.13.2 | MIT OR Apache-2.0 |
| bitreader | 0.3.11 | MIT OR Apache-2.0 |
| bitstream-io | 4.10.0 | MIT/Apache-2.0 |
| bumpalo | 3.20.3 | MIT OR Apache-2.0 |
| byte-slice-cast | 1.2.3 | MIT |
| bytemuck | 1.25.2 | Zlib OR Apache-2.0 OR MIT |
| byteorder | 1.5.0 | Unlicense OR MIT |
| byteorder-lite | 0.1.0 | Unlicense OR MIT |
| bytes | 1.12.1 | MIT |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 |
| clap | 4.6.7 | MIT OR Apache-2.0 |
| clap_builder | 4.6.7 | MIT OR Apache-2.0 |
| clap_derive | 4.6.7 | MIT OR Apache-2.0 |
| clap_lex | 1.1.1 | MIT OR Apache-2.0 |
| color_quant | 1.1.0 | MIT |
| colorchoice | 1.0.5 | MIT OR Apache-2.0 |
| crc32fast | 1.5.2 | MIT OR Apache-2.0 |
| crossbeam-deque | 0.8.8 | MIT OR Apache-2.0 |
| crossbeam-epoch | 0.9.21 | MIT OR Apache-2.0 |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 |
| crunchy | 0.2.4 | MIT |
| document-features | 0.2.12 | MIT OR Apache-2.0 |
| either | 1.18.0 | MIT OR Apache-2.0 |
| equator | 0.4.2 | MIT |
| equator-macro | 0.4.2 | MIT |
| fallible_collections | 0.5.2 | MIT OR Apache-2.0 |
| fast_image_resize | 5.5.0 | MIT OR Apache-2.0 |
| fax | 0.2.7 | MIT |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 |
| flate2 | 1.1.10 | MIT OR Apache-2.0 |
| getrandom | 0.3.4 | MIT OR Apache-2.0 |
| gif | 0.14.2 | MIT OR Apache-2.0 |
| half | 2.7.1 | MIT OR Apache-2.0 |
| heck | 0.5.0 | MIT OR Apache-2.0 |
| image | 0.25.10 | MIT OR Apache-2.0 |
| image-webp | 0.2.4 | MIT OR Apache-2.0 |
| imgref | 1.12.3 | CC0-1.0 OR Apache-2.0 |
| interpolate_name | 0.2.4 | MIT |
| is_terminal_polyfill | 1.70.2 | MIT OR Apache-2.0 |
| itertools | 0.14.0 | MIT OR Apache-2.0 |
| leb128 | 0.2.7 | MIT OR Apache-2.0 |
| libaom-sys | 0.17.2+libaom.3.11.0 | BSD-2-Clause |
| libc | 0.2.190 | MIT OR Apache-2.0 |
| libfuzzer-sys | 0.4.13 | (MIT OR Apache-2.0) AND NCSA |
| libwebp-sys | 0.9.6 | MIT |
| litrs | 1.0.0 | MIT OR Apache-2.0 |
| log | 0.4.34 | MIT OR Apache-2.0 |
| loop9 | 0.1.5 | MIT |
| maybe-rayon | 0.1.1 | MIT |
| memchr | 2.8.3 | Unlicense OR MIT |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 |
| moxcms | 0.8.1 | BSD-3-Clause OR Apache-2.0 |
| moxcms | 0.9.1 | BSD-3-Clause OR Apache-2.0 |
| mozjpeg | 0.10.13 | IJG |
| mozjpeg-sys | 2.2.3 | IJG AND Zlib AND BSD-3-Clause |
| new_debug_unreachable | 1.0.6 | MIT |
| no_std_io2 | 0.9.4 | Apache-2.0 OR MIT |
| nom | 8.0.0 | MIT |
| noop_proc_macro | 0.3.0 | MIT |
| num-bigint | 0.4.8 | MIT OR Apache-2.0 |
| num-derive | 0.4.2 | MIT OR Apache-2.0 |
| num-integer | 0.1.47 | MIT OR Apache-2.0 |
| num-rational | 0.4.2 | MIT OR Apache-2.0 |
| num-traits | 0.2.19 | MIT OR Apache-2.0 |
| once_cell | 1.21.4 | MIT OR Apache-2.0 |
| once_cell_polyfill | 1.70.2 | MIT OR Apache-2.0 |
| owning_ref | 0.4.1 | MIT |
| paste | 1.0.15 | MIT OR Apache-2.0 |
| pastey | 0.1.1 | MIT OR Apache-2.0 |
| png | 0.18.1 | MIT OR Apache-2.0 |
| ppv-lite86 | 0.2.21 | MIT OR Apache-2.0 |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 |
| profiling | 1.0.18 | MIT OR Apache-2.0 |
| profiling-procmacros | 1.0.18 | MIT OR Apache-2.0 |
| pxfm | 0.1.30 | BSD-3-Clause OR Apache-2.0 |
| quick-error | 2.0.1 | MIT/Apache-2.0 |
| quote | 1.0.47 | MIT OR Apache-2.0 |
| r-efi | 5.3.0 | MIT OR Apache-2.0 OR LGPL-2.1-or-later |
| rand | 0.9.5 | MIT OR Apache-2.0 |
| rand_chacha | 0.9.0 | MIT OR Apache-2.0 |
| rand_core | 0.9.5 | MIT OR Apache-2.0 |
| rav1e | 0.8.1 | BSD-2-Clause |
| ravif | 0.13.0 | BSD-3-Clause |
| rayon | 1.12.0 | MIT OR Apache-2.0 |
| rayon-core | 1.13.0 | MIT OR Apache-2.0 |
| rgb | 0.8.53 | MIT |
| simd-adler32 | 0.3.10 | MIT |
| simd_helpers | 0.1.0 | MIT |
| ssimulacra2 | 0.5.1 | BSD-2-Clause |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 |
| strsim | 0.11.1 | MIT |
| syn | 2.0.119 | MIT OR Apache-2.0 |
| syn | 3.0.6 | MIT OR Apache-2.0 |
| thiserror | 2.0.21 | MIT OR Apache-2.0 |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 |
| tiff | 0.11.3 | MIT |
| unicode-ident | 1.0.26 | (MIT OR Apache-2.0) AND Unicode-3.0 |
| utf8parse | 0.2.2 | Apache-2.0 OR MIT |
| v_frame | 0.3.9 | BSD-2-Clause |
| wasip2 | 1.0.4+wasi-0.2.12 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| wasm-bindgen | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-macro | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-macro-support | 0.2.129 | MIT OR Apache-2.0 |
| wasm-bindgen-shared | 0.2.129 | MIT OR Apache-2.0 |
| webp | 0.3.1 | MIT OR Apache-2.0 |
| weezl | 0.1.12 | MIT OR Apache-2.0 |
| windows-link | 0.2.1 | MIT OR Apache-2.0 |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 |
| wit-bindgen | 0.57.1 | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT |
| y4m | 0.8.0 | MIT |
| yuv | 0.1.10 | BSD-2-Clause |
| yuvxyb | 0.4.2 | MIT |
| yuvxyb-math | 0.1.1 | MIT |
| zerocopy | 0.8.59 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zerocopy-derive | 0.8.59 | BSD-2-Clause OR Apache-2.0 OR MIT |
| zlib-rs | 0.6.8 | Zlib |
| zune-core | 0.5.3 | MIT OR Apache-2.0 OR Zlib |
| zune-jpeg | 0.5.15 | MIT OR Apache-2.0 OR Zlib |
