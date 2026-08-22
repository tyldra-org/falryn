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

Falryn is being built so the agent, terminal, tools, and project context live in
one local Bun process. Every file read, command run, and provider call goes
through a single recorded tool path. The work is inspectable, not incidental.

> [!IMPORTANT]
> **That describes the design, not today's binary.** Falryn is early. The
> foundation below works and is tested on three platforms. The agent itself is
> not built yet. Nothing here talks to a model provider.

### What works today

The CLI, its output contracts, and the local state layer underneath them:

```bash
falryn doctor --format json   # bounded environment and storage diagnostics
falryn config show            # effective configuration across profile layers
falryn data reset             # preview or remove Falryn-owned local data
falryn                        # opens the interactive shell on a capable terminal
```

Every command emits `human`, `json`, `jsonl`, or `quiet` output against a
versioned schema. Results go to stdout and diagnostics to stderr, always.
State is local SQLite with versioned migrations. There is an OpenTUI shell,
credential storage with redaction, and a compiled single-file executable.

### What is designed but not built

The agent runtime, model providers, and the tool-call lifecycle. Workspace,
search, Git, and LSP tools. Context management, compression, Brief, Hush, Loom,
memory, artifacts, and computer use. These have written contracts in
[Falryn Docs](https://github.com/tyldra-org/falryn-docs) and open issues. They
have no implementation. Documentation here describes targets. Treat
[`CURRENT-STATE.md`](CURRENT-STATE.md) as the only record of what actually runs.

> [!NOTE]
> Issues and pull requests are restricted to collaborators while the foundation
> is built. Reading, forking, and using the code are not. Falryn is
> [Apache-2.0](LICENSE). Security reports are welcome today. See
> [`SECURITY.md`](SECURITY.md).

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
being made. The behavior is untested, not known-good.
See [`.github/workflows/README.md`](.github/workflows/README.md) for what each
CI job establishes.

## Development

```bash
bun run check     # format, lint, typecheck, repository integrity, and tests
bun run build     # compile the standalone executable into dist/
```

Falryn is built with Bun, TypeScript, React, and OpenTUI, and runs as one
ordinary Bun process. No Falryn-owned engine, IPC layer, or Rust toolchain.
Persistence is local `bun:sqlite` with versioned migrations.

Every change lands through a pull request with all CI checks passing. `main`
takes no direct pushes.

## Project

- [Current state](CURRENT-STATE.md). Verified implementation and planning frontier
- [Falryn Docs](https://github.com/tyldra-org/falryn-docs). Product, architecture, and developer documentation
- [Issues](https://github.com/tyldra-org/falryn/issues). Planned work and open defects
- [Contributing](CONTRIBUTING.md). Outside contributions are not open yet. Security reports are
- [Contributor readiness](CONTRIBUTOR-READINESS.md). The safeguards and single
  future access change for opening external contributions
- [Security policy](SECURITY.md). How to report a vulnerability privately

## License

[Apache License 2.0](LICENSE). Copyright 2026 Yogesh Prasad.

The grant covers the Falryn software: `src/`, `tools/`, the build and CI
configuration, and this repository's documentation. `.agents/skills/` holds
development-time agent guidance that is not part of the
software and is not present in the compiled executable. Anything there
originating from another project stays under its own licence. See
[`NOTICE`](NOTICE).
