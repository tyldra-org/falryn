# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/tyldra-org/falryn/security/advisories/new)
for this repository. Do not open a public issue for a vulnerability: the issue
tracker is world-readable, and a public report is a disclosure.

This channel is open to everyone. Falryn is not otherwise accepting outside
issues or pull requests while its foundation is being built — see
[`CONTRIBUTING.md`](CONTRIBUTING.md) — but that restriction deliberately does
not apply here. A vulnerability you cannot report is worse than one you can.

Expect an acknowledgement within seven days. Falryn is maintained by one person,
so a fix may take longer than an acknowledgement does; the advisory thread is
where that timeline is agreed.

## Supported versions

Falryn has not published a release. Until it does, only the current `main`
branch receives fixes, and no earlier revision is supported.

## Threat model

Falryn is an agent that runs **locally, as you, with your privileges**. It is
designed to read and write your files, hold your provider credentials, and
execute external commands on your behalf. That is the product, not a flaw in it.

**Falryn does not sandbox the agent.** The tool boundary exists so that every
file read, command run, and provider call is validated, typed, and recorded —
it is an auditability and correctness boundary, not a security isolation one. It
is not designed to contain a model that has been persuaded to do something
harmful, and it should not be relied on as though it were.

If you need real isolation — because you are running untrusted input, an
untrusted model, or an untrusted repository — run Falryn inside a container or a
virtual machine. Nothing in Falryn substitutes for that.

Stating this plainly is deliberate: a permission prompt that users believe is a
sandbox is more dangerous than no prompt at all.

## What is in scope

Falryn runs locally and holds credentials, reads and writes a user's files, and
executes external tools on their behalf. The following are the boundaries most
worth attacking:

- credential storage, redaction, and anything that could write a secret to a
  log, diagnostic, or artifact;
- the tool-runner boundary, and any path that reaches the filesystem or an
  external command without passing through it;
- the local SQLite state, its migrations, and its file permissions;
- terminal escape-sequence handling, where crafted model or file content is
  rendered.

## What is not in scope

| Category | Why |
| --- | --- |
| Sandbox escape | The tool boundary is not a sandbox — see the threat model above |
| A model provider's own service | Data you send a provider is governed by that provider's policies |
| Configuration you control | Editing your own config or state is not an attack vector |
| Findings needing prior local code execution | An attacker already running as you has no boundary left to cross |
| `ravencode-references` | Research material, not a dependency of any Falryn build |
