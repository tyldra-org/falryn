<div align="center">

<img src="assets/falryn-mark.png" alt="Falryn" width="112">

# Falryn

**A local terminal coding agent for deliberate work.**

[![CI](https://github.com/tyldra-org/falryn/actions/workflows/ci.yml/badge.svg)](https://github.com/tyldra-org/falryn/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)

<a href="#quickstart">Quickstart</a>
·
<a href="https://github.com/tyldra-org/falryn-docs">Documentation</a>
·
<a href="CURRENT-STATE.md">Current state</a>
·
<a href="CONTRIBUTING.md">Contributing</a>

</div>

---

Falryn keeps the agent, terminal, tools, and project context in one local Bun
process. It is built around explicit boundaries: every file read, command run,
and provider call passes through one recorded tool path, so the work is
inspectable rather than incidental.

> [!NOTE]
> Falryn is pre-release and has published no version. It runs from source, and
> `main` is the only supported revision. [`CURRENT-STATE.md`](CURRENT-STATE.md)
> is the only inventory of what is actually implemented — the documentation
> describes contracts, not shipped behavior.

## Quickstart

```bash
git clone https://github.com/tyldra-org/falryn.git
cd falryn
bun install
bun run dev
```

Build the standalone executable:

```bash
bun run build     # writes dist/falryn
./dist/falryn --version
```

## Platform support

Falryn targets Linux, macOS, and Windows. The three are not qualified to the
same depth, and the difference is deliberate:

| Platform | Source suite | Compiled CLI | Terminal |
| --- | --- | --- | --- |
| Linux x64 | full | verified in CI | not qualified |
| macOS arm64 | full | verified in CI | verified on a real pseudo-terminal |
| Windows x64 | portability baseline | verified in CI | not qualified |

The terminal check allocates a pseudo-terminal through libc's `openpty`, which
Windows has no equivalent for. Where the table says *not qualified*, no claim is
being made — the behavior is untested, not known-good.
See [`.github/workflows/README.md`](.github/workflows/README.md) for what each
CI job establishes.

## Development

```bash
bun run check     # format, lint, typecheck, repository integrity, and tests
bun run build     # compile the standalone executable into dist/
```

Falryn is built with Bun, TypeScript, React, and OpenTUI, and runs as one
ordinary Bun process — no Falryn-owned engine, IPC layer, or Rust toolchain.
Persistence is local `bun:sqlite` with versioned migrations.

Every change lands through a pull request with all CI checks passing; `main`
takes no direct pushes.

## Project

- [Current state](CURRENT-STATE.md) — verified implementation and planning frontier
- [Falryn Docs](https://github.com/tyldra-org/falryn-docs) — product, architecture, and developer documentation
- [Issues](https://github.com/tyldra-org/falryn/issues) — planned work and open defects
- [Contributing](CONTRIBUTING.md) — how to help build Falryn
- [Security policy](SECURITY.md) — how to report a vulnerability privately

## License

[Apache License 2.0](LICENSE).
