# Falryn

A local terminal coding agent for deliberate, inspectable work.

[![CI](https://github.com/tyldra-org/falryn/actions/workflows/ci.yml/badge.svg)](https://github.com/tyldra-org/falryn/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache_2.0-blue.svg)](LICENSE)

Falryn is pre-release and currently runs from source. It keeps command output,
local state, and terminal interaction in one Bun process. Read the
[public current state](CURRENT-STATE.md) for verified capabilities.

## Quick start

~~~bash
git clone https://github.com/tyldra-org/falryn.git
cd falryn
bun install
bun run dev
~~~

Build the standalone executable:

~~~bash
bun run build
./dist/falryn --version
~~~

## Project

- [Current state](CURRENT-STATE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [License](LICENSE)

Falryn is [Apache-2.0](LICENSE). The license covers the repository's source,
tests, build configuration, and other tracked documentation. See [NOTICE](NOTICE)
for attribution information.
