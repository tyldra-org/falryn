# Vendored agent skills

Falryn ships six skill bundles so a public checkout can resolve its normal repository guidance without private documentation, private Roadmap access, or a personal skill installation.

## Inventory

| Tier | Skills | Content |
| --- | --- | --- |
| Portable universal | `git-workflow`, `gh-cli`, `change-review` | General Git, GitHub, and change-review guidance reusable across repositories |
| Portable stack | `typescript-best-practices`, `opentui-best-practices` | Version-aware TypeScript and terminal-UI guidance without Falryn policy |
| Falryn workflow | `falryn-workflow` | Complete Falryn-specific public workflow plus explicit authenticated-maintainer gates for private docs and Roadmap operations |

The five portable skills must remain useful outside Falryn and must not contain Falryn, organization, maintainer-home, or repository-local policy. `falryn-workflow` is the sole project-specific exception.

Each bundle has one compact `SKILL.md` router. Deep references remain only when
they own a distinct concern. The TypeScript bundle has twelve original practice
references, and the OpenTUI bundle has fourteen. Neither bundle contains copied
upstream documentation.

## Resolution

In this checkout, apply system and user instructions first, then repository `AGENTS.md` and `CONTRIBUTING.md`, then the relevant vendored skill. A personal or global skill may add guidance only when it does not replace repository policy.

The Falryn workflow resolves public source, issue, and pull-request work locally. Private Falryn Docs and Roadmap information is used only after exact authenticated maintainer access is proven. Missing private authority produces an explicit unavailable result for private-only operations; it never causes a guessed fallback.

## Load gates

| Skill | Load before |
| --- | --- |
| `typescript-best-practices` | TypeScript, TSX, JavaScript, tests, build scripts, or `tsconfig` work |
| `opentui-best-practices` | Terminal UI, renderer, layout, input, keymaps, or packaging work |
| `git-workflow` | Mutating Git work: commit, branch, rebase, push, or recovery |
| `gh-cli` | GitHub issues, pull requests, Actions, Projects, merge, or exact flags |
| `change-review` | Reviewing a local diff, branch, or pull request; pair with `gh-cli` for GitHub state and a stack skill for changed code |
| `falryn-workflow` | Falryn Plan, Implement, Review, Verify, Merge, Deliver, or Next modes; greetings, walkthroughs, status questions, and next-step routing |

`git-workflow` owns Git. `gh-cli` owns GitHub. `change-review` owns evidence-backed review reasoning. Never substitute one CLI for another.

## Maintenance

The committed bundles are authoritative for this checkout. Keep portable bundle
changes product-neutral. Maintain `falryn-workflow` here as the public Falryn
contract; the private companion adds maintainer-only documentation and Roadmap
authority after access is verified. Personal or global installations are
optional copies and never replace the committed repository guidance.
