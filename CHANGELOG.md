# Changelog

## 1.2.0 - 2026-09-27

### Added

- Add `specdd plugin add` to install named plugins from GitHub shorthand, SSH addresses, and HTTPS URLs, with exact branch, tag, or commit selection from branch and tag history.
- Add `specdd plugin list` with text, JSON, and extended JSON output for registered plugins.
- Add `specdd plugin update` to refresh all managed plugins or a selected repository and plugin, with an optional version override.
- Verify detached plugin signatures using bundled SpecDD keys or local GnuPG keys with full or ultimate identity validity; require explicit default-No confirmation for unsigned or unverified third-party plugins, with distinct warnings for insufficient identity validity.
- Require plugins from every repository under `github.com/specdd/` to verify against the bundled SpecDD keys, failing without a confirmation override when verification fails.
- Record plugin origins, requested versions, and SHA-256 checksums; protect installations and updates with local-edit checks, concurrent registration checks, symlink protection, project locking, and atomic replacement with rollback.

### Fixed

- Accept any valid, eligible bundled signer in detached signatures containing multiple signers, while rejecting expired or revoked primary keys and signing subkeys.

## 1.1.1 - 2026-05-31

### Changed

- Treat parent-held and local directory-level specs as cumulative context in `inspect`, `resolve`, and `lint`.
- Allow `inspect`, `resolve`, and `lint` to target directories, `.sdd` files, and ordinary files with upward context resolution.
- Resolve ordinary file targets through same-basename `.sdd` specs when present, with case-insensitive matching and exact-name preference.
- Resolve non-glob directory links to directory-level specs only; recursive descendant inclusion now requires an explicit glob.
- Extract shared target, root, and directory context discovery for `inspect`, `resolve`, and `lint`.
- Include resolved root and target path metadata in compact JSON output for `inspect` and `lint`.
- Disable symlink traversal during `.sdd` discovery in `inspect`, `resolve`, and `lint`.
- Rename the repository root spec to `cli.sdd` and use folder-basename root spec matching by convention.
- Support `--sections all` and `--section all` in `inspect` and `resolve` to render every SpecDD section.

### Fixed

- Fix `resolve` help text and text relevance ordering for ordinary file targets without same-basename specs.
- Follow explicit `resolve` links wrapped in common inline delimiters such as backticks, brackets, braces, or parentheses.
- Follow explicit `resolve` links to ordinary files through same-basename `.sdd` specs when present.
- Prevent broad non-glob directory links such as `./` from pulling unrelated specs from temporary or nested project folders.

## 1.1.0 - 2026-05-30

### Changed

- Adopt Common Changelog for project release notes.

### Added

- Add `specdd inspect` for tree-shaped SpecDD section inspection.
- Add `specdd lint` for SpecDD syntax diagnostics in text and JSON formats.
- Add `specdd resolve` for bounded relevant-spec discovery from a target path.
- Add shared SpecDD parser, tree discovery, linter, and resolver services.
- Add a packaged Unix manual page with release-time version sync.

## 1.0.1 - 2026-05-24

### Changed

- Update project specs and bootstrap files to SpecDD 1.3.
- Extend release automation with Docker Hub publishing, GitHub release creation, release preflight checks, and a release completion reminder.

### Added

- Add `specdd agentskills deploy` for verified SpecDD Agent Skills installs into project or user Agent Skills directories.

### Fixed

- Prevent `specdd update` from recreating deleted distribution files other than `.specdd/bootstrap.md`.
- Fix the npm package binary path to use `dist/main.js` without a leading `./`.

## 1.0.0 - 2026-05-16

### Added

- Add the initial `specdd init`, `specdd update`, and `specdd check-update` commands for SpecDD project setup and update workflows.
- Add verified SpecDD distribution downloads using bundled OpenPGP trusted keys.
- Add project file preservation, bootstrap metadata parsing, update checking, and CLI logging services.
- Add npm packaging, Docker image support, Homebrew release support, locked dependencies, and test/build tooling.
