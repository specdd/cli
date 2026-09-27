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

## Install Plugins

Run from the project directory containing `.specdd/bootstrap.md`:

```bash
specdd plugin add @acme/specdd-plugins review
specdd plugin add @acme/specdd-plugins review v1.2.0
specdd plugin add git@gitlab.com:team/specdd-plugins.git review <commit>
```

The syntax is `specdd plugin add <repository> <pluginname> [version]`. GitHub shorthand `@owner/repository` uses
`git@github.com:owner/repository.git`. Full SSH addresses and explicit HTTPS URLs are also supported. SCP-style path
segments are limited to ASCII letters, digits, dots, underscores, and hyphens; percent escapes are rejected.
Git and an SSH client must be installed for SSH repositories. Authentication uses your existing SSH agent and SSH
configuration, including `SSH_AUTH_SOCK`, host aliases, and `GIT_SSH_COMMAND`. Load the repository's key into your agent
before running the command. SpecDD keeps host-key verification enabled as configured by your SSH client and reports
authentication failures without retrying over HTTPS.

A named plugin must exist at `.plugins/<pluginname>/plugin.md` in the source repository. SpecDD fetches only branches
and tags, including their history. The optional version is an exact tag, branch, or commit identifier reachable from
a branch or tag; version strings such as `v1.2.0` are preserved. Pull-request refs and other ref namespaces are not
fetched. When the version is omitted, the remote default branch is selected and the recorded version is `latest`.
An explicitly supplied `latest` selects the Git ref with that name. A name shared by a branch and tag is rejected;
use `refs/heads/<name>` or `refs/tags/<name>` to
disambiguate. Semantic version ranges and GitHub release selection are not supported.

Plugins may include a detached OpenPGP signature at `.plugins/<pluginname>/plugin.md.asc`. SpecDD reads both files
from the same resolved commit and verifies the downloaded bytes before installation. Signatures from bundled,
fingerprint-pinned SpecDD vendor keys are accepted automatically. Plugins from any repository under `github.com/specdd/`
must verify against those embedded keys. This applies to shorthand such as `@specdd/plugins`, SSH, and HTTPS, including
hostname and organization case variants. A missing, invalid, expired, revoked, or non-vendor signature fails with an
error and exit status `1`; official sources never fall back to system trust or offer a confirmation override.

For other repositories, signatures outside the bundled keys are checked with `gpg` using your
local keyring and configuration (including `GNUPGHOME`); automatic acceptance requires full or ultimate identity
validity. SpecDD does not retrieve or import keys or change their trust settings. GnuPG is optional for vendor-signed
plugins and required for system-key verification; install it separately where needed, including in custom Docker images.

For these other repositories, unsigned plugins and signatures that cannot be verified produce a warning and
`Continue? [y/N]`, defaulting to No.
A cryptographically valid signature with unknown or marginal identity validity receives a separate warning showing
the signing key's full fingerprint and validity; `TRUST_NEVER` explicitly warns that the identity is untrusted.
Expired or revoked keys receive specific warnings. Continue only after confirming that the signing key belongs to
a vendor you trust. Only `y` or `yes` (case-insensitive) permits installation. Refusal, cancellation, or noninteractive
input/output exits with status `1` without changing the plugin or registry. Required warnings remain visible regardless
of `log_level`. These checks also apply to repeated additions and `plugin update`, including otherwise unchanged files.
The registry's `sig` field remains a content checksum, separate from publisher signature verification.

The installed file is `.specdd/plugins/<host>/<namespace>/<repository>/<pluginname>/plugin.md`. Repository coordinates
retain nested namespaces, omit `.git`, and include a nondefault port as `<host>~<port>`. For example, the first command
above installs `.specdd/plugins/github.com/acme/specdd-plugins/review/plugin.md`.

`.specdd/plugins.json` records an array of objects with four string fields:

| Field | Value |
| --- | --- |
| `src` | Plugin file path; generated entries use a path relative to `plugins.json`. |
| `origin` | Repository address followed by `#` and the full resolved commit identifier. |
| `sig` | Lowercase SHA-256 checksum of the exact installed file bytes. |
| `version` | Supplied tag, branch, or commit string, or `latest` when omitted. |

The origin preserves the repository path and any `.git` suffix; passwords and HTTPS user information are removed.

Existing `src` values may be absolute, relative to `plugins.json` (including `../`), or start with `~` for your home
directory. Unrelated registrations and their path spelling are preserved, even if their files are unavailable.
Malformed registries, missing fields, and duplicate source paths are rejected before installation.

Adding the same plugin again updates its registration. Identical bytes and metadata produce a no-op; changing only
the requested version updates `version`. Existing files must be registered and match their recorded checksum before
replacement, so local edits are preserved. Missing registered files can be restored by adding the plugin again.
Changes to the target registration during download, verification, or confirmation cancel the operation, including
otherwise unchanged installations. Unrelated registrations and additional metadata are preserved.
Managed writes reject symlink paths. Registry write failures roll back the plugin file; a failed rollback reports its
path. Concurrent installs are rejected while `.specdd/plugins.lock` is held. If a process is forcibly terminated,
confirm no install is running before removing a stale lock; check the plugin against its recorded checksum before
retrying. Successful commands exit with `0`; expected installation failures exit with `1` and a concise error.

For Docker on Linux, forward an existing agent socket and mount SSH configuration and known hosts read-only:

```bash
docker run --rm -it --user "$(id -u):$(id -g)" \
  -v "$PWD:/workspace" \
  -v "$SSH_AUTH_SOCK:/ssh-agent" -e SSH_AUTH_SOCK=/ssh-agent \
  -v "$HOME/.ssh:/home/node/.ssh:ro" \
  ghcr.io/specdd/cli:latest plugin add @acme/specdd-plugins review
```

The container user must have a passwd entry and permission to access the agent socket, project directory, and SSH
configuration; the image's `node` user has UID `1000`. If your UID differs, provide a matching container user setup and
SSH home path. Docker Desktop requires its platform-specific SSH agent socket mount. The image includes Git and
OpenSSH; SpecDD does not copy keys or start an agent.

## List Plugins

List the plugins registered in the current directory's `.specdd/plugins.json`:

```bash
specdd plugin list
specdd plugin list --output json
specdd plugin list --output json-extended
```

`--output` accepts `text` (the default), `json`, or `json-extended`. `--format` is an alias, consistent with the other
read commands; when repeated, the last value wins. Text shows each plugin's source path, version, origin, and SHA-256
checksum in registry order. JSON returns `rootDirectoryPath`, `registryPath`, and a `plugins` array with the four
registry fields described above. Extended JSON also preserves any additional fields on each registration.

A missing registry or empty array returns `No plugins installed.` in text or an empty `plugins` array in JSON,
with exit status `0`. Listing does not require a bootstrap file or create files. It includes external registrations
and preserves their source path spelling, even when the plugin file is unavailable; it does not verify files or
contact Git repositories. Invalid output formats and unreadable or malformed registries fail with exit status `1`.

## Update Plugins

Refresh all managed plugins at their recorded versions, or select a repository and plugin with an optional version override:

```bash
specdd plugin update
specdd plugin update @acme/specdd-plugins review
specdd plugin update @acme/specdd-plugins review v2.0.0
```

With no arguments, `specdd plugin update` updates all managed plugins. For one plugin, use
`specdd plugin update <repository> <pluginname> [version]`; repository and plugin name must be supplied together.
Repository inputs and plugin names follow the same rules as `plugin add`, including GitHub shorthand, SSH addresses,
and HTTPS URLs. Equivalent repository URLs resolve to the same canonical repository coordinates and plugin path.
Only registrations whose resolved `src` is under the current project's `.specdd/plugins/` are selected; external
registrations and their files are left untouched. The name is the directory immediately containing `plugin.md`, and
the path must match the repository coordinates recorded in `origin`. Absolute, relative, and `~` source spelling is
preserved when it resolves to a managed path.

Updates fetch from the Git repository in `origin`, using the recorded `version`; the old commit fragment in `origin`
is provenance, not the update target. A recorded `latest` follows the remote default branch. Pinned tags, branches,
and commits keep their recorded values. An explicit version overrides and replaces the named plugin's recorded version.
As with `add`, an explicit `latest` selects the Git ref named `latest`; use `refs/tags/latest` or `refs/heads/latest` to
keep that meaning on subsequent updates. SSH uses the existing Git and agent authentication settings. The repository
argument selects the installation; fetching still uses its recorded origin and transport.

A targeted update requires a matching managed repository-and-plugin coordinate. Plugins with the same name in other
repositories are left untouched. An uninstalled coordinate fails before downloading, and a bare plugin name is rejected.
With no managed registrations, the command prints `No managed plugins installed.` and succeeds
without creating files. Updating an installed plugin requires `.specdd/bootstrap.md`, as for `add`.

Updates retain source spelling, registration order, and additional metadata while refreshing `origin`, `sig`, and
`version`. They preserve the same checksum, symlink, locking, and rollback protections as `add`, and reject a
registration changed after selection, including during verification or confirmation. All selected source metadata is
validated before installation starts. Plugins are then processed in registry order; a failure stops the command with
exit status `1`, retaining earlier successful updates. Successful commands exit with `0`.

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
