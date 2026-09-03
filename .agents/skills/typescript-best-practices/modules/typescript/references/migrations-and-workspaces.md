# Migrations and workspaces

## JavaScript to TypeScript

Migrate one boundary at a time:

1. establish the runtime and build baseline;
2. introduce TypeScript through the repository's existing toolchain;
3. include JavaScript only where needed and use `checkJs` deliberately;
4. type external input and public boundaries before internals;
5. rename modules in coherent slices while preserving runtime resolution;
6. tighten strictness with explicit diagnostics and tests;
7. remove temporary shims after their last consumer migrates.

Do not use a broad ambient declaration to erase unknown package shapes without documenting the boundary and replacement plan.

## Workspaces and project references

Use project references when package boundaries, build order, declaration ownership, or incremental isolation justify them—not merely because a repository has several directories.

Each referenced project should have coherent source/output ownership and compatible `composite`, declaration, root, and package-export settings. The root solution config can contain only references when that matches the build graph.

## Tool migrations

Choose Biome, ESLint, formatters, task runners, or monorepo orchestrators from repository requirements and measured gaps. Avoid universal size thresholds or “tool X for simple, tool Y for complex” rules. A migration needs:

- current rule/behavior inventory;
- explicit unsupported or changed rules;
- deterministic config translation;
- before/after diagnostics and formatting diff;
- CI and editor integration;
- rollback or staged adoption when output is large.
