---
name: opentui-extended
description: Companion guide for OpenTUI framework selection, patterns, configuration, and gotchas. Use after the skill router when choosing Core vs React vs Solid, or when troubleshooting. Prefer sibling docs/**/*.mdx on API conflicts.
---

# OpenTUI Extended

Companion to upstream `docs/**/*.mdx`. Decision trees and pattern refs live here; API details live upstream.

Paths below are relative to this file's directory (`modules/opentui-extended/`).

## Critical rules

1. Prefer `bun create tui` / `bunx create-tui@latest` for new apps. Agents: always `-t core|react|solid` (non-interactive). Options before the directory name: `bunx create-tui -t react my-app`.
2. Call `renderer.destroy()` (or framework teardown) on exit. Do not bare-`process.exit()` without destroying the renderer. See `docs/core-concepts/lifecycle.mdx`.
3. In React/Solid, style text with nested modifier elements—not style props. See `references/components/text-display.md` and `docs/components/text.mdx`.
4. Bun is the reference runtime. Native `createCliRenderer()` in Node needs Node **26.4.0+** with `--experimental-ffi` (and `--allow-ffi` under the permission model). Portable imports (`@opentui/keymap`, non-renderer `@opentui/core`) do not need FFI.

## How to use

| Need | Read |
| --- | --- |
| Framework overview / quick start | `references/<core\|react\|solid>/REFERENCE.md` |
| Writing code | `.../api.md` + matching `docs/components/*.mdx` |
| Project setup | `.../configuration.md` |
| Implementation patterns | `.../patterns.md` |
| Troubleshooting | `.../gotchas.md` + `references/testing/REFERENCE.md` |

Cross-cutting entrypoints: `references/layout|components|keyboard|keymap|animation|testing/REFERENCE.md`.

**Reading order:** framework `REFERENCE.md` → task files above → upstream MDX for the exact API.

## Framework choice

```
Which API?
├─ Max control / libs on OpenTUI / no reconciler → core
├─ React component model → react
├─ Fine-grained reactivity → solid
└─ Unsure for an app → react or solid (not core)
```

## Component chooser

Prefer `docs/components/<name>.mdx` for the component you pick. Use category files when comparing options:

```
Display?
├─ Text / ASCII / QR → components/text-display.md  (+ docs/components/text|ascii-font|qr-code.mdx)
├─ Box / scroll / scrollbar → components/containers.md
├─ Table / code / diff / markdown / line-number → components/code-diff.md
Input?
├─ input / textarea / select / tab-select / slider → components/inputs.md
├─ Layered commands → keymap/REFERENCE.md  (+ docs/keymap/overview.mdx)
└─ Raw keys / focus / paste / selection → keyboard/REFERENCE.md  (+ docs/core-concepts/keyboard.mdx)
Layout? → layout/REFERENCE.md + layout/patterns.md  (+ docs/core-concepts/layout.mdx)
Animation? → animation/REFERENCE.md
Testing? → testing/REFERENCE.md  (+ docs/core-concepts/testing.mdx)
```

## Platform capabilities

| Capability | Companion | Upstream |
| --- | --- | --- |
| Audio | `references/core/api.md` | `docs/core-concepts/audio.mdx` |
| Notifications | `references/core/api.md` | `docs/core-concepts/notifications.mdx` |
| SSH | `references/core/REFERENCE.md` | `docs/reference/ssh.mdx` |
| Custom stdin/stdout | `references/core/api.md` | `docs/core-concepts/renderer.mdx` |

## Troubleshooting index

| Symptom | Start |
| --- | --- |
| Dirty terminal / crash on exit | `references/core/gotchas.md` + `docs/core-concepts/lifecycle.mdx` |
| Text styles ignored (React/Solid) | `references/components/text-display.md` |
| Focus / shortcuts | `references/keyboard/REFERENCE.md` |
| Layout misalignment | `references/layout/REFERENCE.md` + `patterns.md` |
| Flaky snapshots | `references/testing/REFERENCE.md` |
| Naming Core vs JSX | `references/components/REFERENCE.md` |

## Product map

| Area | Entry |
| --- | --- |
| Core / React / Solid | `references/core|react|solid/REFERENCE.md` |
| Layout, keyboard, keymap, animation, testing | `references/<concept>/REFERENCE.md` |
| Component categories | `references/components/REFERENCE.md` |
| `@opentui/keymap` | `references/keymap/REFERENCE.md` + `docs/keymap/` |
| `@opentui/qrcode` | `references/components/text-display.md` + `docs/components/qr-code.mdx` |
| `@opentui/ssh` | `docs/reference/ssh.mdx` |
| `@opentui/three` | `docs/reference/three.mdx` |

## External links

- Repo: https://github.com/anomalyco/opentui
- Docs site: https://opentui.com/docs/getting-started
- Examples: https://github.com/anomalyco/opentui/tree/main/packages/examples
- create-tui: https://github.com/msmps/create-tui
- Awesome list: https://github.com/msmps/awesome-opentui
