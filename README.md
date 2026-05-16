# SpecDD CLI

SpecDD CLI is a tool for working with SpecDD framework-enabled projects.

Use it to add SpecDD files to a project, update an existing SpecDD setup, and keep the local SpecDD framework files in
sync with official releases.

## Install

For npm or Yarn installs, SpecDD CLI requires Node.js 22 or newer.

With npm:

```bash
npm install --global specdd
```

With Yarn:

```bash
yarn global add specdd
```

With Homebrew:

```bash
brew tap specdd/cli
brew install specdd
```

With Docker:

```bash
# Docker Hub
docker run --rm specdd/cli:latest --help
# GitHub Container Registry
docker run --rm ghcr.io/specdd/cli:latest --help
```

## Initialize A Project

Initialize SpecDD in the current directory:

```bash
specdd init
```

Initialize SpecDD in another directory:

```bash
specdd init path/to/project
```

If the target directory does not exist, `specdd init` creates it. If the directory already exists, SpecDD is added only
when `.specdd/bootstrap.md` is not already present.

Using Docker:

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/specdd/cli:latest init
```

## Update A Project

Run update from inside a project that already has SpecDD initialized:

```bash
specdd update
```

`specdd update` requires `.specdd/bootstrap.md` to exist in the current directory.

When using the default latest release, `specdd update` compares the local bootstrap `Version` front matter against the
latest release and does nothing when the local version is already current or newer.

When an update is applied, SpecDD CLI prints the changelog link from the updated bootstrap file so you can review what
changed.

Using Docker:

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/specdd/cli:latest update
```

## Check For Updates

Check the local SpecDD version against the latest available release:

```bash
specdd check-update
```

`specdd check-update` prints the local version, if any, and the latest release version. It exits with code `0` when no
update is needed and code `1` when an update is available.

Using Docker:

```bash
docker run --rm -v "$PWD:/workspace" ghcr.io/specdd/cli:latest check-update
```

## Versions

By default, commands use the latest SpecDD release.

Install or update from a specific release:

```bash
specdd init --version 1.2.3
specdd update --version 1.2.3
```

Versions use dotted numeric values such as `1.2` or `1.2.3`, without a leading `v`. If the requested version already
matches the local bootstrap version, `specdd update` does nothing.

## File Safety

SpecDD CLI downloads official release files, verifies their signature, and then applies them to the target project.

Existing project files are preserved. The only existing file that may be overwritten is:

```text
.specdd/bootstrap.md
```

`specdd init` and `specdd update` also create `.specdd/.gitignore` when it is missing. That file ignores
`bootstrap.local.md`.

## Logging

Set the log level with `SPECDD_LOG_LEVEL`.

Supported values:

```text
error
warning
warn
log
info
debug
```

Example:

```bash
SPECDD_LOG_LEVEL=debug specdd update
```

## Learn More

SpecDD documentation: https://specdd.ai

CLI help and issues: https://github.com/specdd/cli
