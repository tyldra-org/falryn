<p align="center">
  <img src="assets/branding/falryn-falcon-mark-navy-coral-clean.png" alt="Falryn falcon mark" width="220">
</p>

<h1 align="center">Falryn</h1>

<p align="center">
  <strong>A local terminal coding agent, built from scratch with Bun, TypeScript, and OpenTUI.</strong>
</p>

<p align="center">
  <a href="#start-here">Start here</a>
  ·
  <a href="#development">Development</a>
  ·
  <a href="#project-map">Project map</a>
  ·
  <a href="https://github.com/tyldra-org/falryn-docs">Documentation</a>
  ·
  <a href="https://github.com/users/yogeshprasad098/projects/2">Roadmap</a>
</p>

---

## A deliberate foundation for coding work

Falryn is an independent terminal coding agent. It is not a RavenCode migration,
fork, or compatibility layer: its product, runtime, data model, and release
history are its own.

The project is designed around a simple principle: an agent should make its
work legible. Invocation, tool use, cancellation, recovery, and durable
artifacts each have explicit, typed boundaries instead of being hidden inside a
single opaque loop.

| | |
| --- | --- |
| **Local by default** | One normal Bun process for interactive work; no Falryn-owned engine or IPC layer. |
| **TypeScript end to end** | Bun, strict TypeScript, React, and OpenTUI—without a Rust workspace or Cargo toolchain. |
| **Designed to recover** | Typed lifecycle, error, configuration, data, and scheduling foundations keep uncertainty visible rather than silently papering over it. |

## Start here

> [!NOTE]
> Falryn is actively under construction. [`CURRENT-STATE.md`](CURRENT-STATE.md)
> is the source of truth for what has been implemented and verified. Product
> designs and roadmap issues describe the intended direction; they are not
> release or availability claims.

```bash
bun install
bun run dev
```

For the complete command set and contributor workflow, see
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Development

| Command | Purpose |
| --- | --- |
| `bun run check` | Run formatting, linting, type checking, repository-integrity checks, and tests. |
| `bun run build` | Compile the standalone `falryn` executable into `dist/`. |
| `bun run dev` | Run the TypeScript entry point locally. |
| `bun test` | Run the Bun test suite. |
| `bun run measure` | Run the opt-in persistence-resource measurement suite. |

The pinned toolchain is Bun `1.3.14`, TypeScript `7.0.2`, Biome `2.5.6`, and
OpenTUI `0.4.5`.

## Project map

| Looking for | Start with |
| --- | --- |
| What is working right now? | [`CURRENT-STATE.md`](CURRENT-STATE.md) |
| What is planned or in progress? | [Falryn Roadmap](https://github.com/users/yogeshprasad098/projects/2) |
| Product, architecture, and user documentation | [`tyldra-org/falryn-docs`](https://github.com/tyldra-org/falryn-docs) |
| Canonical documentation owner for a change | [Documentation map](https://github.com/tyldra-org/falryn-docs/blob/main/DOCUMENTATION-MAP.md) |
| How to contribute | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

The application and tests live here. The companion
[`falryn-docs`](https://github.com/tyldra-org/falryn-docs) repository owns
product, architecture, user-guide, and developer-reference documentation.

## Contributing

Small, focused changes are easiest to review and verify. Read
[`CONTRIBUTING.md`](CONTRIBUTING.md), choose one ready and unblocked issue for
meaningful work, and keep the change scoped to that outcome.
