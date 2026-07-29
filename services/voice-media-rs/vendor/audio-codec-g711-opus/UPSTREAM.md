# audio-codec 0.3.40 provenance

This directory is a minimal compatibility fork used only to remove the
unreviewed G.729 dependency from the normal `voice-media-rs` build graph. It
is not a G.729 implementation source. The only permitted future G.729 source
candidate remains the separately pinned rvoip candidate recorded by the Goal
4 contract, and that candidate remains runtime-disabled.

- Upstream repository: `https://github.com/restsend/audio-codec`
- Upstream crate: `audio-codec`
- Upstream version: `0.3.40`
- Upstream VCS commit: `b074337d37be797771b258daacafb87aa833c015`
- crates.io archive SHA-256: `c1affd3ba1faa8ae5c47c98f6c5e36eb321f4cb4567d7a7e1a8f3452fe40d57a`
- crates.io archive size: `24377` bytes
- Upstream license metadata: `MIT`

The upstream crate archive declares MIT in `Cargo.toml` but does not include a
license file. This fork therefore carries the standard MIT text in `LICENSE`.

## Local changes

- Retain only the PCMU, PCMA, Opus, and Resampler modules used by
  `voice-media-rs`.
- Remove G.722 and telephone-event modules from this compatibility surface.
- Remove the G.729 module, public enum variant, factories, and the
  unconditional `g729-sys` dependency.
- Rewrite `src/lib.rs` as the exact consumer-facing surface: codec sample
  aliases, PCMU/PCMA/Opus modules, Resampler, codec traits, the three-variant
  `CodecType`, and generic encoder/decoder factories.
- Remove unused upstream conversion helpers, `TryFrom`/metadata methods, and
  specialized `create_opus_*` factories. This also removes the upstream
  little-endian byte-to-sample pointer cast instead of carrying an unused,
  potentially unaligned API.
- Pin `opus-rs` exactly to `0.1.23`.

The retained `pcmu.rs`, `pcma.rs`, `opus.rs`, and `resampler.rs` module files
are byte-for-byte copies from the pinned crate archive. Only the compatibility
surface in `src/lib.rs` and dependency manifest are narrowed.

No G.729 codec implementation, binding, feature, or runtime gate exists in
this package.
