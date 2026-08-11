---
name: opentui
description: Build, configure, test, debug, and package terminal UIs with OpenTUI Core, React, or Solid. Use for TUI components, layout, input, keymaps, animations, audio, plugins, SSH, and Bun standalone executables.
---

# OpenTUI

Use the sibling `docs/**/*.mdx` files as the primary, upstream reference.
`modules/opentui-extended/` is a bundled companion guide, not a second skill.

## Workflow

1. Read repository guidance and inspect the installed OpenTUI version before
   choosing APIs or configuration.
2. Start with one current upstream entry from the routing table, then load only
   the narrower documents needed for the task.
3. Use `modules/opentui-extended/GUIDE.md` for framework selection, patterns,
   configuration, gotchas, or troubleshooting; follow only its relevant
   references.
4. Prefer the upstream MDX docs when the companion guide differs.
5. Use the framework's documented renderer cleanup rather than calling
   `process.exit()` from UI code; cover interaction changes with focused tests.

## Routing

| Task | Start here |
| --- | --- |
| New project or installation | `docs/getting-started.mdx` |
| Core renderer, lifecycle, or scrollback | `docs/core-concepts/renderer.mdx` |
| React or Solid APIs | `docs/bindings/react.mdx` or `docs/bindings/solid.mdx` |
| Components, styling, inputs, or selection | `docs/components/<name>.mdx` |
| Flexbox/Yoga layout or terminal resizing | `docs/core-concepts/layout.mdx` |
| Keyboard events, paste, focus, or keymaps | `docs/core-concepts/keyboard.mdx` or `docs/keymap/overview.mdx` |
| Animation or framework choice | `modules/opentui-extended/GUIDE.md` |
| Test renderer, snapshots, or frame tests | `docs/core-concepts/testing.mdx` |
| Audio, notifications, plugins, SSH, QR, Three.js, or packaging | `docs/core-concepts/audio.mdx`, `docs/plugins/slots.mdx`, or the relevant `docs/reference/*.mdx` |

For concrete component work, read the matching file in `docs/components/`.
For plugins, narrow from `docs/plugins/slots.mdx` into the Core, React, or Solid
plugin guide.
