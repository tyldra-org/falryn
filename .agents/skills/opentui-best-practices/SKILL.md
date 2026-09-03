---
name: opentui-best-practices
description: OpenTUI Core, React, and Solid implementation and review for renderer lifecycle, components, layout, input, keymaps, testing, plugins, media, SSH, and standalone packaging. Uses a version-pinned official documentation snapshot plus compact non-duplicating practices.
---

# OpenTUI best practices

The installed package exports and the matching pinned official documentation in `docs/` are the API source of truth. [UPSTREAM.md](UPSTREAM.md) records the exact source and refresh contract. The three files in `references/` add stable workflow and review guidance without copying API tables.

## Invariants

1. Inspect installed `@opentui/*` versions and the existing Core, React, or Solid setup before selecting APIs.
2. Start with one exact MDX owner from the routing table. Load a practices reference only for framework choice, implementation structure, troubleshooting, or review.
3. When source types and the pinned MDX disagree, inspect the installed package. Consult newer upstream docs only to diagnose a mismatch or plan an upgrade; do not silently use main-branch APIs with an older package.
4. The owner that creates a renderer, framework root, plugin, subscription, worker, or server owns its documented cleanup. Do not call `process.exit()` from reusable UI code.
5. Host-owned keystrokes, focus, rendering, layout, and shutdown must not wait on unbounded work or synchronous plugin IPC.
6. Cover changed interaction, focus, resize, rendering, and lifecycle behavior with the documented test renderer or focused integration tests.

## Route one exact owner

| Task | Start here |
| --- | --- |
| Install, quickstart, runtime support | [Getting started](docs/getting-started.mdx), [quickstart](docs/getting-started/quickstart.mdx), or [runtime support](docs/getting-started/runtime-support.mdx) |
| Renderer, lifecycle, rendering pipeline | [Renderer](docs/core-concepts/renderer.mdx), [lifecycle](docs/core-concepts/lifecycle.mdx), or [pipeline](docs/core-concepts/rendering-pipeline.mdx) |
| Renderables, text/cells, layout | [Renderables](docs/core-concepts/renderables.mdx), [text and cells](docs/core-concepts/text-and-cells.mdx), or [layout](docs/core-concepts/layout.mdx) |
| React or Solid binding | [React](docs/bindings/react.mdx) or [Solid](docs/bindings/solid.mdx) |
| Component selection or exact props | [Component overview](docs/components/overview.mdx), then `docs/components/<name>.mdx` |
| Keyboard, paste, focus, selection, clipboard | [Interaction](docs/core-concepts/interaction.mdx), [keyboard](docs/core-concepts/keyboard.mdx), or [clipboard](docs/core-concepts/clipboard.mdx) |
| Layered keymaps and commands | [Keymap overview](docs/keymap/overview.mdx), then the Core, React, Solid, host, or addon page |
| Tests, rendering diagnostics, troubleshooting | [Testing](docs/core-concepts/testing.mdx), [rendering diagnostics](docs/test-and-debug/rendering-diagnostics.mdx), or [troubleshooting](docs/test-and-debug/troubleshooting.mdx) |
| Custom renderables, editing, post-processing, runtime plugins | `docs/extend/*.mdx` |
| Plugin contribution and slots | [Plugin slots](docs/plugins/slots.mdx), then the Core, React, or Solid page |
| Animation or audio applications | `docs/application-apis/*.mdx` and [audio](docs/core-concepts/audio.mdx) |
| Tree-sitter, package entrypoints, native buffers/images, terminal capabilities, Yoga | `docs/reference/*.mdx` |
| SSH, Three.js, QR, deployment, standalone executables | [SSH](docs/reference/ssh.mdx), [Three.js](docs/reference/three.mdx), [QR](docs/reference/qr-encoder.mdx), [deployment](docs/ship/deploy.mdx), or [standalone](docs/reference/standalone-executables.mdx) |
| Framework choice and implementation structure | [Implementation practices](references/implementation.md) |
| Diagnose a failure without copying stale API guesses | [Troubleshooting practices](references/troubleshooting.md) |
| Review an OpenTUI change | [Review checklist](references/review.md) plus the exact changed API MDX |

Do not load the whole MDX corpus. Read only the pages required by the changed surface.
