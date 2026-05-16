# Development

This document is for contributors working on the SpecDD CLI codebase.

For CLI usage, see `README.md`. For source-adjacent requirements, read the relevant `.sdd` specs before editing code.

## Prerequisites

- Node.js 22 or newer.
- Yarn 1.x. The project currently declares `yarn@1.22.22`.

Install dependencies:

```bash
yarn install
```

## Architecture

The CLI is organized as a small layered application. The entrypoint owns process concerns, the container owns object
wiring, commands translate CLI input into service calls, and services own application behavior.

```text
main.ts
  -> Container
       -> commands
       -> services
       -> infrastructure adapters
```

### Entrypoint

`src/main.ts` exposes the `Main` class and contains the self-running package entrypoint. It builds the root `specdd`
command from command instances exposed by `Container`.

`Main` is intentionally testable:

- `run(argv)` parses caller-provided argv values.
- Commander exits are overridden so tests can assert behavior without process exits.
- `selfRun(...)` receives process dependencies explicitly, including realpath resolution, so package-bin symlink
  behavior is testable.

### Container

`src/container.ts` is the composition root. It creates shared infrastructure adapters, services, and command instances.

Dependencies are wired explicitly through constructors. Commands and services should not reach for global service
instances or construct their own collaborators. If a new service or command is added, it should be exposed through
`Container` once its local spec defines that behavior.

### Commands

Command modules live in `src/commands`.

Commands are CLI adapters. They should parse command arguments and options, resolve CLI-facing values such as paths, and
delegate to services. They should not download releases, verify signatures, inspect zip files, or apply distributions
directly.

Current command flow:

```text
specdd init [path] [--version]
  -> DistributionInstaller.init(...)

specdd update [--version]
  -> DistributionInstaller.update(...)
```

### Services

Services live under `src/services`, with each service in its own directory.

The current distribution pipeline is:

```text
DistributionInstaller
  -> DistributionClient downloads specdd.zip and specdd.zip.asc
  -> SignatureVerifier verifies the zip against embedded trusted keys
  -> DistributionApplier applies verified files to the target directory
```

Supporting services:

- `Config` resolves configuration from readers and defaults.
- `Logger` writes CLI notices with levels and colors.

Services depend on narrow collaborator interfaces, usually `Pick<...>` types, so tests can provide small fakes and the
runtime container can provide concrete adapters.

### Infrastructure

Infrastructure adapters live in `src/infrastructure`.

These classes wrap Node or runtime APIs:

- `FetchClient` wraps `fetch`.
- `FileSystem` wraps filesystem operations.
- `TempDirectory` wraps temporary directory creation.

Adapters should stay thin. Application decisions belong in services, not infrastructure wrappers.

## Project Layout

```text
src/app.sdd                         root project spec
src/main.ts                         CLI entrypoint
src/main.sdd                        entrypoint spec
src/container.ts                    composition root
src/container.sdd                   container spec
src/commands                        command handlers
src/infrastructure                  runtime adapters
src/services                        application services
src/services/*/service.sdd          service specs
```

## Development Commands

Run the full build and release-prep check:

```bash
make build
```

Run type checking:

```bash
yarn typecheck
```

Run tests:

```bash
yarn test
```

Run tests with coverage:

```bash
yarn test:coverage
```

Build:

```bash
yarn build
```

Before considering a change complete, run:

```bash
yarn typecheck
yarn test:coverage
yarn build
```

The project expects full coverage for functions, services, and commands.

## Security Choices

Dependency security is intentionally conservative:

- Direct runtime and development dependencies are pinned to exact versions in `package.json`.
- `yarn.lock` is committed and checked with `yarn install --frozen-lockfile`.
- `npm-shrinkwrap.json` is committed and included in the published package so npm installs of the CLI use the locked
  dependency tree.
- Yarn ignores `npm-shrinkwrap.json`, so both lock files are maintained.
- `make build` refreshes the npm shrinkwrap metadata after version or dependency changes.
- Shrinkwrap sync runs with `--ignore-scripts` to avoid executing dependency lifecycle scripts during lock metadata
  updates.
- Both `yarn security:audit` and `npm audit --audit-level=info` are run by `make build`.
- `npm pack --dry-run` is part of `make build` so package contents, including `npm-shrinkwrap.json`, are checked before
  release.

Runtime distribution verification is also self-contained:

- Distribution signatures are verified in Node.js through the OpenPGP library.
- Trusted SpecDD signing public keys are embedded in TypeScript source.
- Runtime verification must not shell out to external `gpg` or other system commands.

After bumping the package version, run:

```bash
make build
```

This updates shrinkwrap metadata, runs audits, typechecks, tests, builds, and verifies the package dry run.

To publish a release, update the Homebrew tap, and publish the Docker image after confirmation prompts, run:

```bash
make release
```

To update only the Homebrew tap formula after an npm package has already been published, run:

```bash
make bump-homebrew
```

The target reads the version from `package.json` by default. Use `VERSION=1.2.3` to override it.

To build and push the official multi-architecture Docker images after the npm package has been published, run:

```bash
make docker-release
```

This publishes:

```text
ghcr.io/specdd/cli:<version>
ghcr.io/specdd/cli:latest
specdd/cli:<version>
specdd/cli:latest
```

for:

```text
linux/amd64
linux/arm64
```

The Docker image installs the published npm package for the requested version. It does not build from local source.

For a local single-architecture smoke check after publishing:

```bash
make docker-build
make docker-smoke
```

## Local CLI Smoke Check

After building, run:

```bash
node dist/main.js --help
```

The package binary points to `dist/main.js`.

## Adding Behavior

Start with the smallest relevant spec. For a new command, add a command spec and command module, then wire the command
through `Container`. For a new service, add a service directory with its `service.sdd`, implementation, and focused
tests.

Keep boundaries explicit:

- CLI parsing belongs in commands.
- Workflow orchestration belongs in services.
- Node/runtime calls belong behind infrastructure adapters.
- Shared runtime wiring belongs in `Container`.

## Configuration

Config values currently come from environment variables using the `SPECDD_` prefix.

Example:

```bash
SPECDD_LOG_LEVEL=debug yarn test
```

Config keys should have defaults declared in the config defaults class. Accessing an undeclared key intentionally emits
a warning.
