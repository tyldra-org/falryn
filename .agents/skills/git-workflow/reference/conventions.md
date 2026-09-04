# Conventions

Message text and naming. Load before writing any commit subject, branch name, or tag. Pull-request titles live in **gh-cli** `process/pr.md`.

**Repo convention wins.** If `git log --pretty=%s -n 30` shows an established style, match it. Defaults below apply only when the repo has no opinion.

Repo templates (`commitlint`, `.gitmessage`, PR template) outrank this file.

## What makes a subject good

The format is the easy part and almost never the problem. A subject can be perfectly conventional and still worthless:

```
fix(auth): fix bug in auth        <- conventional, says nothing
fix(auth): reject tokens whose exp equals now
```

The test: someone scanning `git log --oneline` six months from now, hunting for when a behavior changed. Does the subject answer them, or make them open the diff?

Name the behavior that changed, not the fact that files were edited. Keep the specific nouns from the diff, such as the flow, helper, command, endpoint, screen, or config key. Those nouns make history searchable.

## Form

```
type(scope): summary
type: summary          # when the scope is broad, weak, or unclear
type(scope)!: summary  # breaking change
```

- **Lowercase** type, scope, and first word after the colon. No sentence capitalization.
- **Imperative mood.** Use `add`, `fix`, `extract`, or `stop`, not `added`, `fixes`, or `adding`. The convention reads as an instruction: apply this commit and it will "add X".
- **Keep it readable in one log line.** Follow a repository-enforced limit. Otherwise prefer a concise subject and shorten anything that hides the changed behavior. Length alone does not prove a commit should split.
- **No trailing period.** It's a title, not a sentence.
- **No version tokens** (`[v2]`, `v1.2.3`). The tag carries the version; a subject carrying it goes stale the moment history is rewritten.
- **No vague summaries**: `updates`, `changes`, `fix issue`, `update logic`, `wip`, `misc`, `cleanup` alone.
- **No tool watermarks or AI attribution.** `Co-Authored-By:` is legitimate for real human co-authors; not for tools.

## Types

Pick by **effect on the codebase**, not by which files moved or which verb came to mind first. Renaming a variable inside a bug fix is still `fix`.

| Type | Use for |
|---|---|
| `feat` | New user-visible capability |
| `fix` | Correcting broken or wrong behavior |
| `refactor` | Restructure with no intended behavior change |
| `perf` | Performance |
| `docs` | Documentation only |
| `test` | Tests only |
| `build` | Build system, packaging, dependencies |
| `ci` | Pipelines, workflows, automation config |
| `chore` | Maintenance touching neither src nor tests |
| `style` | Formatting or lint only, no meaning change |
| `revert` | Reverts a previous commit |

The four calls that actually get made wrong:

- **`feat` vs `fix`.** Did this add something that did not exist, or correct something that was wrong? Missing null handling is a fix. Adding CSV support is a feature.
- **`refactor` vs `perf`.** Use `perf` only when speed or memory is the point and the change can be measured.
- **`chore` vs `build`.** A dependency bump is `build`. Maintenance of unrelated configuration is `chore`.
- **`fix` vs `docs`.** User-facing product copy is `fix`. README text is `docs`.

## Scope

The scope is the affected subsystem, such as a package, module, service, or domain. It is not a filename.

Read the repo's actual vocabulary before inventing one:

```bash
git log --pretty=%s -n 30 | sed -n 's/^\([a-z]*\)(\([^)]*\)).*/\2/p' | sort -u
```

In a monorepo the scope is usually the package or app directory. **Omit the scope rather than invent one**; `docs: clarify local setup` beats `docs(misc): clarify local setup`. A weak scope is worse than none, because it teaches future readers a category that doesn't exist.

## Commit message bodies and trailers

Repository policy, contributor policy, hooks, and legal requirements decide
whether a message is subject-only or carries a body, footers, or trailers.
Preserve required DCO sign-offs, real co-author attribution, breaking-change
metadata, and issue references. Never strip existing metadata merely to apply a
generic style.

When no effective policy requires a body, keep transient validation and session
narration in the issue or pull-request body rather than inventing commit prose.
For breaking changes, use the repository's established subject marker and/or
required trailer; migration details belong where that repository requires them.

## Writing one

1. **Read the change.** `git diff --stat` and `--name-only` for shape, then the actual diff for the files that matter. Filenames mislead; a change in `utils.js` could be any of six types.
2. **Read the repo's voice.** `git log --pretty=%s -n 20`. Note the type vocabulary, whether scopes are used, how specific summaries run.
3. **Name the intent in one sentence, to yourself.** "This stops the session expiring one second early." If you can't, you don't understand the change well enough to title it; read more diff.
4. **Pick the type** from that sentence's effect, then the scope, then write the summary using the diff's own nouns.
5. **Apply the six-months-later test** and trim to length.

## Examples

Diff → subject, with the reasoning:

**Example 1**
Input: `src/auth/token.js` changes `t.exp > Date.now()` to `t.exp >= Date.now()`
Output: `fix(auth): treat tokens expiring this instant as still valid`
*Not `fix(auth): change comparison operator`; that describes the diff, not the behavior.*

**Example 2**
Input: `invoice.js` gains a `tax()` function; `total()` now multiplies by quantity
Output: two commits, `fix(billing): multiply line items by quantity in total` and `feat(billing): add tax calculation helper`
*One subject can't honestly cover both. Needing "and" is the signal to split.*

**Example 3**
Input: `package.json` and lockfile bump axios 1.6.2 → 1.7.4, changelog cites a CVE
Output: `build(deps): bump axios to 1.7.4 for CVE-2024-28849`
*The reason is the entire value; a bare version bump tells a future reader nothing about whether they can defer it.*

**Example 4**
Input: 40 files, every `getUserById` renamed to `findUserById`, no logic change
Output: `refactor(users): rename getUserById to findUserById`
*Large file count, single reason to change; one commit.*

**Example 5**
Input: `.github/workflows/release.yml` now runs publish only on tag pushes
Output: `ci(release): publish only from tagged builds`

Strong subjects combine behavior and object:

- `feat(auth): add background SSO refresh with runtime controls`
- `fix(router): stop false-positive classification in fallback routes`
- `refactor(sync): extract event batching from legacy pipeline`
- `docs(readme): document the API_TOKEN env var`
- `test(auth): cover token expiry handling in session renewal`
- `chore: refresh ESLint config for shared TypeScript rules`

Weak subjects describe the act of editing:

`feat: add stuff` · `fix: update logic` · `chore: changes` · `docs: edits` · `wip` · `misc`

## Rewriting an existing message

1. Normalize the type and the form to `type(scope): summary`.
2. Convert past tense to imperative.
3. Strip version tokens and release prefixes. Legacy formats like `[v2.4] Add background enrichment` usually have a *good* summary behind the token; keep it, replace only the prefix: `feat(enrichment): add background enrichment with runtime controls`.
4. Replace vague wording with the real changed behavior and object.
5. Represent breaking behavior and required metadata exactly as the effective
   repository policy specifies.
6. Preserve required bodies, footers, and trailers; changing the subject does
   not authorize deleting metadata.
7. **Keep the existing wording where it's already clear, conventional, and specific.** Rewriting a good subject into your own phrasing is churn, not improvement.

Rewriting a *published* commit's message is a history rewrite; see [rewrite.md](rewrite.md) before touching anything already pushed.

## When the type is genuinely ambiguous

Offer 2 to 3 options with a one-line reason each rather than picking silently:

```
feat(sync): add retry on transient upload failure; if the retry is new capability
fix(sync): retry transient upload failures; if uploads were considered broken without it
```

The user knows which framing is true; you're guessing. One quick question beats a subject that misrepresents the change in permanent history.

## Branch names

Format: `<prefix>/<short-kebab-description>` or `<prefix>/<ticket>-<short-kebab-description>`.

A branch name is chosen by the contributor or automation creating it; GitHub issue and PR numbers do not dictate or reorder it. The optional ticket segment is a traceability key, while the description carries human meaning. Prefer the repository's real issue key or number when one exists, but do not rename work merely to make unrelated auto-generated numbers appear sequential.

| Prefix | Use for |
|---|---|
| `feat/` | New capability |
| `fix/` | Bug fix |
| `docs/` | Documentation |
| `refactor/` | Restructure |
| `perf/` | Performance |
| `test/` | Tests |
| `ci/` | Pipeline |
| `chore/` | Maintenance |
| `release/` | Release preparation |
| `backup/` | Safety ref before a destructive operation; never pushed |

Rules:

- Lowercase descriptive words, kebab-case, and ASCII. Preserve a tracker key's required case. No spaces, no `~^:?*[\`, no trailing `.lock`, no `..`.
- Short: 3 to 5 words after the prefix. The pull-request title (host skill) carries the detail.
- Include the ticket ID when the project uses one: `fix/PROJ-412-null-session-token`.
- One branch, one logical change. If it needs "and" in the name, it's two branches.

**Long-lived branches** (`main`, `master`, `develop`, `release/*`, and any integration branch the repo already runs) are exempt from the prefix rule; they follow whatever the repo established, which is usually older than the convention.

## Tags

When the repository uses Semantic Versioning and has no different tag convention, prefer `v<major>.<minor>.<patch>` and `v1.2.0-rc.1` for a prerelease. Follow the repository's annotated, signed, or lightweight tag policy. See [release.md](release.md).

## Merge subjects

When repository policy permits Git's default merge message,
`Merge branch '<branch>'` is an administrative subject rather than a
conventional change type. Preserve any required message body or trailers.

A GitHub squash merge often starts from the PR title, but the final reviewed
message and metadata follow repository policy; **gh-cli** `process/merge.md`.
