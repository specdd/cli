# Contributing to SpecDD CLI

Thank you for your interest in contributing. We welcome bug reports, ideas, documentation improvements, and pull
requests.

## Before You Start

Read `README.md` for user-facing behavior and `DEVELOPMENT.md` for project architecture, security choices, and local
development commands.

This project uses SpecDD. Learn the framework at https://specdd.ai.

Before changing code, read the relevant `.sdd` specs next to the code you plan to edit. Specs are source-adjacent
development contracts.

## Issues and Discussions

For CLI bugs, feature requests, and implementation proposals, use the SpecDD CLI issue tracker:

https://github.com/specdd/cli/issues

For broader SpecDD framework questions or proposals, use the main SpecDD project:

https://github.com/specdd/specdd

If your idea is still open-ended, start with a discussion before investing in a larger change.

## Pull Requests

Open a pull request once the change is concrete and ready to review. Reference the related issue when there is one.

Keep pull requests focused. Update specs, tests, and documentation together with behavior changes.

Before submitting, run:

```bash
make build
```

`make build` refreshes shrinkwrap metadata, runs dependency audits, typechecks, tests, builds, and checks package
contents.

## Security

Please do not report security issues in public issues or pull requests. See `SECURITY.md`.

## License

By contributing to this project, you agree that your contributions will be licensed under the Apache License 2.0.
