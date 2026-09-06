# Reporting

Report only observed facts.

Include:

- exact repository, issue, pull request, milestone, and revision identities available to the current access profile;
- whether the run used public-only or authenticated maintainer authority;
- authorized mutations and verified resulting state;
- commands and checks with outcomes;
- merged, pending, failed, skipped, partial, unavailable, or blocked bundle members;
- documentation-impact classification without reproducing private content;
- residual risks, limitations, and safe recovery; and
- one next eligible action.

For a file the user may inspect, provide its clickable absolute local path in chat plus repository-qualified path and durable link when that location is public and useful. Never commit machine-specific paths.

Do not print private document text, private Project fields, snapshots, authenticated API responses, credentials, or private checkout paths into public issues, pull requests, commits, artifacts, or logs. Use the public classifications in [documentation delivery](documentation-delivery.md) and report only the delivery fact required.

A completed mode or orientation ends with one exact copy-ready line:

```text
Suggested next prompt: Deliver - Target: Issue #123
```

Use the repository's recognized typographic-dash form when required by its interface. Derive the prompt from fresh authoritative state. A suggestion does not authorize the action. If required private access is unavailable, use `Suggested next prompt: none` and name the missing maintainer action.

For continuing work, prefer the automatic delivery selector appropriate to the
verified scope, following [Next's routing](next.md#choose-the-delivery-scope).
Use a manual-stage suggestion only when the user's requested control or a
concrete isolated task calls for it, and state that reason. Needs Planning alone
does not require a manual prompt because Deliver includes planning.
