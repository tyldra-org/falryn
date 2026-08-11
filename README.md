<div align="center">

<img src="assets/falryn-mark.png" alt="Falryn" width="112">

# Falryn

**A local terminal coding agent for deliberate work.**

<a href="#get-started">Get started</a>
·
<a href="https://github.com/tyldra-org/falryn-docs">Documentation</a>
·
<a href="https://github.com/users/yogeshprasad098/projects/2">Roadmap</a>
·
<a href="CONTRIBUTING.md">Contributing</a>

</div>

---

Falryn keeps the agent, terminal, tools, and project context in one local
workspace. It is built around explicit boundaries: work should be inspectable,
actions should be intentional, and the result should leave a useful trail.

## Get started

```bash
bun install
bun run dev
```

Falryn currently runs from source. See
[`CURRENT-STATE.md`](CURRENT-STATE.md) for the verified implementation
inventory; the roadmap describes where the product is going, not what is
already released.

## Development

```bash
bun run check  # format, lint, typecheck, repository integrity, and tests
bun run build  # compile the standalone falryn executable into dist/
```

Falryn is built with Bun, TypeScript, React, and OpenTUI. It runs as one local
Bun process—without a Falryn-owned engine, IPC layer, or Rust toolchain.

## Project

- [Current state](CURRENT-STATE.md) — verified implementation and planning frontier.
- [Falryn Docs](https://github.com/tyldra-org/falryn-docs) — product, architecture, and developer documentation.
- [Falryn Roadmap](https://github.com/users/yogeshprasad098/projects/2) — live planning and priorities.
- [Contributing](CONTRIBUTING.md) — how to help build Falryn.
