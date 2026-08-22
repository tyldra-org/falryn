# Falryn user guide

Falryn is a pre-release local terminal coding agent. It currently runs from
source; no published installer or package is available.

## Run from source

~~~bash
git clone https://github.com/tyldra-org/falryn.git
cd falryn
bun install
bun run dev
~~~

Build a standalone executable with:

~~~bash
bun run build
./dist/falryn --version
~~~

## Command surface

| Command | Purpose |
| --- | --- |
| `falryn` | Start the interactive terminal application. |
| `falryn doctor` | Run bounded environment and local-storage diagnostics. |
| `falryn config` | Inspect or validate configuration. |
| `falryn data` | Preview or remove Falryn-owned local data. |
| `falryn workspace` | Work with named workspace sets. |
| `falryn export` | Preview or write a versioned local export package. |
| `falryn session` | List or inspect local sessions. |
| `falryn artifact` | Inspect locally stored artifacts. |

Use `falryn --help` or `falryn <command> --help` for flags and subcommands.

## Support and project status

- [Current state](../CURRENT-STATE.md) records source-verified capabilities.
- [Security policy](../SECURITY.md) explains private security reporting.
- [License](../LICENSE) applies to the source, tests, build material, and these
  public documents.
