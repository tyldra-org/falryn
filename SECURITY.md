# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/tyldra-org/falryn/security/advisories/new)
for this repository. Do not open a public issue for a vulnerability: the issue
tracker is world-readable, and a public report is a disclosure.

Expect an acknowledgement within seven days. Falryn is maintained by one person,
so a fix may take longer than an acknowledgement does; the advisory thread is
where that timeline is agreed.

## Supported versions

Falryn has not published a release. Until it does, only the current `main`
branch receives fixes, and no earlier revision is supported.

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

- Vulnerabilities in a model provider's service rather than in Falryn's use of it.
- A finding that requires an attacker to already have local code execution as
  the user running Falryn.
- The contents of `ravencode-references`, which is research material rather than
  a dependency.
