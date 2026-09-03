---
name: opentui-best-practices
description: OpenTUI Core, React, and Solid engineering for renderer lifecycle, rendering, layout, input, focus, testing, debugging, extensions, and packaging. Use for implementation or review; consult installed-version documentation for exact APIs.
---

# OpenTUI best practices

Use this skill to choose the structure and proof of an OpenTUI change. Installed
package exports and version-matched official documentation own exact API names,
props, events, defaults, and package entrypoints. This bundle owns engineering
judgment and does not duplicate an API manual.

The references include original TypeScript and TSX patterns. Treat them as
design examples, not as a compatibility promise. Confirm imports, component
names, props, and event fields against the installed OpenTUI version before
using them.

## Working method

1. Resolve the installed OpenTUI packages, versions, runtime, binding, terminal
   modes, and validation commands.
2. Identify who owns the renderer, framework root, input, focus, subscriptions,
   native resources, and shutdown.
3. Keep domain behavior independent of OpenTUI and project it into explicit UI
   state.
4. Model input, focus, resize, scrolling, loading, cancellation, and failure as
   observable state transitions.
5. Keep rendering and keystroke handling bounded. Move blocking or streaming
   work behind cancellable owners.
6. Prove behavior with the test renderer first, then use real-terminal or
   packaged smoke tests only for behavior a headless renderer cannot establish.

## Invariants

1. One visible lifecycle owns renderer creation, framework mounting, cleanup,
   and terminal restoration.
2. Framework-owned renderables are changed through their framework contract,
   not mutated behind the reconciler.
3. Layout follows measured terminal cells and constraints, never guessed browser
   CSS behavior or one fixed terminal size.
4. Input resolves intent before effects run. Focus and keymap precedence are
   deterministic and testable.
5. Empty, loading, unavailable, cancelled, and failed states remain visible.
6. Packaged applications resolve every native asset and entrypoint without
   relying on source-tree paths.

## Routing

| Concern | Read |
| --- | --- |
| Renderer ownership, UI state boundaries, startup, shutdown, suspend, or resume | [Architecture and lifecycle](references/architecture-and-lifecycle.md) |
| Components, text cells, layout, resize, scrolling, rendering cost, or visual fallback | [Rendering and layout](references/rendering-and-layout.md) |
| Keyboard, paste, mouse, focus, selection, commands, or keymap precedence | [Input and interaction](references/input-and-interaction.md) |
| Imperative renderable construction, updates, removal, or disposal | [Core binding](references/core-binding.md) |
| React roots, hooks, effects, refs, keys, or component identity | [React binding](references/react-binding.md) |
| Solid roots, signals, effects, cleanup, or reactive ownership | [Solid binding](references/solid-binding.md) |
| Test renderer use, frame evidence, failure reproduction, cleanup, or performance diagnosis | [Testing and debugging](references/testing-and-debugging.md) |
| Native assets, Tree-sitter, workers, media, SSH, standalone builds, or deployment | [Packaging and runtime resources](references/packaging-and-runtime-resources.md) |
| Plugins, custom renderables, registration, compatibility, or extension cleanup | [Extensions and plugins](references/extensions-and-plugins.md) |

Load one primary reference. Add another only when the task crosses a separate
lifecycle, interaction, or distribution boundary. Pair this skill with the
repository's change-review process for review reasoning.

## Completion check

- Do source types and version-matched documentation support every API used?
- Can one owner restore the terminal and release every resource after success,
  failure, cancellation, and repeated mount or shutdown?
- Do narrow, wide, resized, focused, and unavailable states behave explicitly?
- Do tests prove state and interaction before relying on frame snapshots?
- Does the packaged artifact work without development-only paths or resources?
