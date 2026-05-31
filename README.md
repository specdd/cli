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

## Deploy Agent Skills

Deploy the latest SpecDD Agent Skills release into the current project:

```bash
specdd agentskills deploy
```

Deploy into another project directory:

```bash
specdd agentskills deploy path/to/project
```

Deploy into the current user's Agent Skills directory:

```bash
specdd agentskills deploy --user
```

Project installs write to `<project>/.agents/skills`. User installs write to `~/.agents/skills`.

Install a specific Agent Skills release tag:

```bash
specdd agentskills deploy --version 1.2.3
```

`--user` cannot be combined with a target path.

## Inspect Specs

Inspect SpecDD specs for the current directory:

```bash
specdd inspect
```

Inspect another directory, `.sdd` file, or ordinary file:

```bash
specdd inspect path/to/project
specdd inspect path/to/project/project.sdd
specdd inspect path/to/project/src/feature.ts
```

Root-level project specs follow the containing directory basename convention, so a project in `path/to/project` uses
`project.sdd`.

Targets must exist. Directory targets include specs under that directory plus upward directory context. `.sdd` targets
include that spec plus upward directory context. Ordinary file targets include a same-basename `.sdd` file such as
`feature.sdd` for `feature.ts` when present; when no matching spec exists, inspect still walks upward through directory
context.

By default, inspect output includes each spec's `Purpose` section when present. Include other sections with repeated
`--section` options or a comma-separated `--sections` option:

```bash
specdd inspect --section Purpose --section Must
specdd inspect --sections Purpose,Must,Tasks
specdd inspect --sections all
```

Use `--sections all` to include every SpecDD section present in each spec.

The default output is text. It groups specs by directory headings rooted at the scanned directory, such as `/`,
`/commands/`, and `/services/config/`.

Directory-level specs include both parent-held specs such as `src/foo/bar.sdd` and local specs such as
`src/foo/bar/bar.sdd` when both exist. Parent-held specs are shown before local specs for that directory.

```bash
specdd inspect --format text
```

Use compact JSON for tools. It returns each section body as an array of lines. Use the extended JSON format for the full
internal service result:

```bash
specdd inspect --format json
specdd inspect --format json-extended
```

## Resolve Specs

Resolve relevant specs for a target directory, `.sdd` file, or ordinary file:

```bash
specdd resolve path/to/project/src/feature
specdd resolve path/to/project/src/feature/feature.sdd
specdd resolve path/to/project/src/feature/handler.ts
```

Use `--root` to set the project root used for upward resolution and `/`-prefixed spec paths:

```bash
specdd resolve --root path/to/project path/to/project/src/feature
```

`resolve` always includes vertical directory context from the target up to the root. It then expands soft links from the
target spec and nearby parent context specs using `Owns`, `Can modify`, `Can read`, `References`, `Depends on`, and
`Structure`. Only explicit local paths beginning with `./`, `../`, or `/` are followed. Non-glob directory links resolve
to the directory-level specs for that directory; use a glob such as `./**/*.sdd` to include descendant specs.

Targets must exist. Ordinary file targets use a same-basename `.sdd` file as the target anchor when present; otherwise
`resolve` continues with upward directory context only.

Directory context includes both parent-held specs such as `src/foo/bar.sdd` and local specs such as
`src/foo/bar/bar.sdd` when both govern the same directory. Parent-held specs are resolved before local specs.

Depth controls how far `resolve` expands from the target and parent context:

- `--depth 0`: vertical context only, with no soft-link expansion.
- `--depth 1`: direct soft links from the target spec only.
- `--depth 2`: target links plus the immediate parent context spec; this is the default and can pull siblings through
  parent links such as `./**/*.sdd`.
- `--depth 3`: also expands the next parent context level.
- `--depth all`: recursively follows all reachable links with cycle protection.

```bash
specdd resolve --depth 0 path/to/project/src/feature
specdd resolve --depth 1 path/to/project/src/feature
specdd resolve --depth 2 path/to/project/src/feature
specdd resolve --depth 3 path/to/project/src/feature
specdd resolve --depth all --root path/to/project path/to/project/src/feature
```

Like `inspect`, `resolve` shows `Purpose` by default and accepts section filters and output formats:

```bash
specdd resolve path/to/project/src/feature --section Purpose --section Must
specdd resolve path/to/project/src/feature --sections Purpose,Must,Tasks
specdd resolve path/to/project/src/feature --sections all
specdd resolve path/to/project/src/feature --format text
specdd resolve path/to/project/src/feature --format json
specdd resolve path/to/project/src/feature --format json-extended
```

## Lint Specs

Lint SpecDD specs for the current directory:

```bash
specdd lint
```

Lint another directory, `.sdd` file, or ordinary file:

```bash
specdd lint path/to/project
specdd lint path/to/project/project.sdd
specdd lint path/to/project/src/feature.ts
```

Targets must exist. Directory targets lint specs under that directory plus upward directory context. `.sdd` targets lint
that spec plus upward directory context. Ordinary file targets lint a same-basename `.sdd` file when present; when no
matching spec exists, lint still walks upward through directory context.

The default output is text. It prints only files with diagnostics, followed by indented diagnostic bullets:

```text
path/to/spec.sdd:
  - Syntax error, line 3: Body entries must be indented by exactly 2 spaces
```

Use JSON output for tools:

```bash
specdd lint --format text
specdd lint --format json
```

Lint reports all visible parse errors within each discovered spec in one run. It exits with status `1` when errors are
present.

Lint uses the same directory-level spec layout as `inspect`, including cumulative parent-held and local directory specs.

## Versions

By default, commands use the latest SpecDD release.

Install or update from a specific release:

```bash
specdd init --version 1.2.3
specdd update --version 1.2.3
```

Versions use dotted numeric values such as `1.2` or `1.2.3`, without a leading `v`. If the requested version already
matches the local bootstrap version, `specdd update` does nothing.

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
