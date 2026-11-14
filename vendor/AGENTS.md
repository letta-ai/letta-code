# Vendored Ink Patches (Red Zone)

`vendor/ink/` and `vendor/ink-text-input/` contain patched Ink runtime
internals. `scripts/postinstall-patches.js` applies these at install time by
exact string match.

- Any PR touching `vendor/ink/build/*` or `scripts/postinstall-patches.js` is a
  red zone: patches are fragile to Ink version bumps, semantically invisible to
  normal review, and coordinated across multiple runtime files.
- Verify the exact matched strings still exist and the throw-on-missing guard is
  preserved.
- After editing vendor files, must run build for changes to take effect.
