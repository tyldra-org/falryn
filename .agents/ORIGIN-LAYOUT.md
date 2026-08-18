# Falryn Origin + GitHub layout

Repo-local overlay for global skills **`origin-cli`**, **`git-workflow`**, and **`gh-cli`**. Those skills stay generic; this file holds **Falryn-specific** slugs, remotes, and policy choices.

## Repos

| Repo | GitHub (public, clone, PR, CI) | Origin (private mirror, git push) |
| --- | --- | --- |
| App | `tyldra-org/falryn` | `ecl1pse/falryn` |
| Docs | `tyldra-org/falryn-docs` | `ecl1pse/falryn-docs` |

Both Origin repos: **`mirrorStatus: inbound`**. Contributors clone **GitHub**.

## Remotes (typical checkout)

```bash
git remote -v
# origin  https://origin.cursor.com/ecl1pse/falryn.git
# github  git@github.com:tyldra-org/falryn.git
```

- **Push / pull (maintainer):** `git push origin`
- **PRs / merge / checks:** `gh pr … --repo tyldra-org/falryn` (not `origin pr`)

## Origin ruleset tiers (this org)

| Tier | Where | Falryn choice |
| --- | --- | --- |
| 1 | GitHub full rulesets | Active — enforcement for contributors |
| 2 | Origin light `protect-main` | **Active** on both Origin repos |
| 3 | Origin full GitHub parity | **Disabled** in `~/.agents/skills/origin-cli/config/rulesets.json` |

Apply Tier 2:

```bash
python3 ~/.agents/skills/origin-cli/scripts/sync-github-rulesets.py --origin-repo ecl1pse/falryn
python3 ~/.agents/skills/origin-cli/scripts/sync-github-rulesets.py --origin-repo ecl1pse/falryn-docs
```

Enable Tier 3 only when detaching Origin or explicit maintainer request — see global `origin-cli` → `reference/ruleset.md`.
