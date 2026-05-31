# SpecDD project specific overrides

The root of the project is the repository root.

The root spec file of the project is `/cli.sdd`.

The source tree spec file is `/src/src.sdd`.

## Code style

1. Enforce strict typing wherever possible.
2. Use Yoda conditions for comparisons, where applicable.
3. End statements with semicolons.
4. Use single quotes for strings.
5. Always use curly braces for code blocks.
6. Use spaces for indentation.
7. Use trailing commas in arrays and objects.
8. Follow object-oriented programming principles where appropriate.
9. Enforce strong API boundaries. Do not expose internal implementation details unnecessarily.
10. Separate features, concerns, and related units into dedicated services.
11. Follow the single responsibility principle.
12. Prefer `!comparison` over `false === comparison`.
13. Prefer early returns to reduce nesting and improve control flow clarity.
14. Apply logging generously, using appropriate log levels for the context.
