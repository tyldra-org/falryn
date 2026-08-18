---
name: opentui
description: >-
  Build, configure, test, debug, and package terminal UIs with OpenTUI Core,
  React, or Solid. Use for TUI components, layout, input, keymaps, animations,
  audio, plugins, SSH, QR, Three.js, and Bun standalone executables.
---

# OpenTUI

Upstream `docs/**/*.mdx` is the source of truth. `modules/opentui-extended/` is a companion for framework choice, patterns, and gotchas. It is not a second skill.

## Rules

1. Inspect the installed OpenTUI version and the project's existing Core / React / Solid setup before choosing APIs.
2. Start with one upstream doc from the routing table. Load only narrower docs needed for the task.
3. Use `modules/opentui-extended/GUIDE.md` for framework selection, patterns, configuration, or troubleshooting, then only its relevant references.
4. When the companion guide and upstream MDX disagree, prefer the MDX.
5. Shut down with the documented renderer cleanup (`renderer.destroy()` / framework teardown). Do not `process.exit()` from UI code. Cover interaction changes with focused tests.

## Routing

| Task | Start here |
| --- | --- |
| New project or installation | `docs/getting-started.mdx` |
| Core renderer, lifecycle, scrollback | `docs/core-concepts/renderer.mdx`, `docs/core-concepts/lifecycle.mdx` |
| Renderables vs constructs | `docs/core-concepts/renderables.mdx`, `docs/core-concepts/constructs.mdx` |
| React or Solid APIs | `docs/bindings/react.mdx` or `docs/bindings/solid.mdx` |
| Specific component API | `docs/components/<name>.mdx` |
| Flexbox / Yoga / resize | `docs/core-concepts/layout.mdx` |
| Colors / console | `docs/core-concepts/colors.mdx`, `docs/core-concepts/console.mdx` |
| Keyboard, paste, focus, selection | `docs/core-concepts/keyboard.mdx` |
| Layered keymaps / commands | `docs/keymap/overview.mdx` → `docs/keymap/core.mdx` / `react.mdx` / `solid.mdx` |
| Framework choice, patterns, gotchas | `modules/opentui-extended/GUIDE.md` |
| Animation | `modules/opentui-extended/references/animation/REFERENCE.md` |
| Test renderer, snapshots, frames | `docs/core-concepts/testing.mdx` |
| Audio / notifications | `docs/core-concepts/audio.mdx`, `docs/core-concepts/notifications.mdx` |
| Plugins | `docs/plugins/slots.mdx` → `docs/plugins/core.mdx` / `react.mdx` / `solid.mdx` |
| SSH, QR, Three.js, packaging, env | `docs/reference/ssh.mdx`, `qr-encoder.mdx`, `three.mdx`, `standalone-executables.mdx`, `env-vars.mdx` |

## Ownership

| Concern | Canonical home |
| --- | --- |
| API truth, install, lifecycle, testing | `docs/**/*.mdx` |
| Framework pick, decision trees, gotchas | `modules/opentui-extended/GUIDE.md` |
| Pattern / config / gotcha deep-dives | `modules/opentui-extended/references/**` |
| Per-component props and examples | `docs/components/<name>.mdx` |
| Cross-framework component chooser | `modules/opentui-extended/references/components/REFERENCE.md` |

## Common pairings

- New React TUI → `getting-started` + `bindings/react` (plus extended GUIDE if choosing framework)
- Layout bug → `layout.mdx`, then extended `layout/patterns.md` if needed
- Input / focus → `keyboard.mdx`, then `keymap/overview.mdx` for layered bindings
- Flaky snapshots → `testing.mdx`, then extended `testing/REFERENCE.md` if stuck
- Plugin slot work → `plugins/slots.mdx`, then Core/React/Solid plugin guide

## Create a project

Prefer `bun create tui` / `bunx create-tui@latest`. For agents, pass `-t core|react|solid` (non-interactive). Put CLI options before the project name: `bunx create-tui -t react my-app`.
