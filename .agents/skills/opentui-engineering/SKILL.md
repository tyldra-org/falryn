---
name: opentui-engineering
description: Implement and assess OpenTUI rendering, input, framework bindings, terminal lifecycle and packaging. Use installed exports and version-matched documentation for exact APIs.
---

# OpenTUI engineering

Own terminal rendering, input, renderer lifetime and packaged runtime behavior.
TypeScript guidance owns language and module correctness; general engineering
guidance owns domain design; `change-review` owns review method and reporting.
Keep application policy outside this portable skill.

## Identify the terminal contract

Resolve installed OpenTUI packages, compatible bindings, published exports,
runtime, screen mode and validation tools. Use source types and version-matched
official documentation for API details. A package version recorded in a skill
is not proof that its examples work in the current checkout.

Identify the changed terminal behavior and the owner of its renderer, framework
root, focus, input registrations and native resources. Domain state reaches the
UI through explicit projections. Keep rendering and keystroke work bounded.

One visible lifetime must restore terminal state after normal exit, failure,
cancellation and repeated startup. Framework reconciliation owns its renderables;
do not mutate them through a competing owner. Terminal cells, focus and output
modes need terminal evidence, not assumptions from browser CSS or DOM behavior.

## Choose the owning reference

| Concern | Read |
| --- | --- |
| Versions, Bun or Node support, package selection, public entry points, peers, or platform constraints | [Runtime and package selection](references/runtime-and-package-selection.md) |
| Renderer ownership, UI state boundaries, startup, shutdown, suspend, or resume | [Architecture and lifecycle](references/architecture-and-lifecycle.md) |
| Components, text cells, layout, resize, scrolling, rendering cost, or visual fallback | [Rendering and layout](references/rendering-and-layout.md) |
| Keyboard, paste, mouse, focus, selection, commands, or keymap precedence | [Input and interaction](references/input-and-interaction.md) |
| Layered shortcuts, named commands, sequences, user bindings, command palettes, or shortcut help | [Keymaps and commands](references/keymaps-and-commands.md) |
| Timeline, easing, live rendering, frame cadence, motion cleanup, or reduced motion | [Animation and live rendering](references/animation-and-live-rendering.md) |
| Split-footer output, captured stdout, scrollback snapshots, streaming code or Markdown, or long-running output | [Scrollback and streaming](references/scrollback-and-streaming.md) |
| Terminal capabilities, colors, clipboard, notifications, images, audio, capture, or graceful fallback | [Terminal capabilities and application services](references/terminal-capabilities-and-application-services.md) |
| Imperative renderable construction, updates, removal, or disposal | [Core binding](references/core-binding.md) |
| React roots, hooks, effects, refs, keys, or component identity | [React binding](references/react-binding.md) |
| Solid roots, signals, effects, cleanup, or reactive ownership | [Solid binding](references/solid-binding.md) |
| Test renderer use, frame evidence, failure reproduction, cleanup, or performance diagnosis | [Testing and debugging](references/testing-and-debugging.md) |
| Native assets, Tree-sitter, workers, media, SSH, standalone builds, or deployment | [Packaging and runtime resources](references/packaging-and-runtime-resources.md) |
| Plugins, custom renderables, registration, compatibility, or extension cleanup | [Extensions and plugins](references/extensions-and-plugins.md) |

Load one primary reference, plus another for a distinct interaction, binding or
distribution risk. Ordinary layout work does not need every extension, media,
animation or package guide.

## Verify what the user experiences

Use a test renderer for state, cells, layout and interaction. Exercise relevant
resize, focus, cancellation and unavailable-capability cases. Frame snapshots
alone do not prove which command ran or whether resources were released.

Use a real terminal for behavior the headless renderer cannot establish, such as
terminal restoration or actual capability fallback. Use the packaged executable
for native asset and entrypoint resolution. Keep those proof levels separate and
run the repository's required checks. A pure domain change need not acquire a
terminal smoke test just because its caller eventually renders text.

Report observed behavior, package/runtime versions when relevant, and material
gaps through the task's existing report. Avoid a second universal checklist.
