# Changelog

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
