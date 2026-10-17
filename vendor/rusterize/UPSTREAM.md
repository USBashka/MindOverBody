# Rusterize

Source: https://github.com/USBashka/Rusterize

Pinned commit: `92db95ba70e27e3426247397b3698805024fdacf`.

The Rust core and browser host are vendored for reproducible, offline-capable
builds, under their original MIT OR Apache-2.0 license. Core Rust sources are
unchanged. The Cargo manifest expands upstream workspace metadata and omits
the benchmark target, which is not included in this distribution.

Two small additive methods in `hosts/web/rusterize.js` support embedding:
`writeBytes(pointer, Uint8Array)` copies validated ranges into the application
scratch buffer, and `refresh()` resumes the application after a graph update.
The upstream RZ02 wire protocol, event handling, drawing and text remain intact.
