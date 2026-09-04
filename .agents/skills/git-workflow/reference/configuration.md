# Configuration and repository policy

Git configuration can come from system, global, local, worktree, includes, environment, and command-line scopes. Change the narrowest scope that satisfies the request. Never use `--global` as a convenience for a repository-specific problem.

## Resolve effective values

Query specific keys with origin and scope rather than dumping credentials or unrelated configuration:

```bash
git config --show-origin --show-scope --get-all <key>
git config --show-origin --show-scope --get-regexp '<reviewed-pattern>'
```

Inspect conditional includes when the effective value is surprising. Do not remove a higher-scope value merely because a lower-scope override would solve the repository need.

After setting or unsetting a value, query it again and report the scope and origin. Local configuration lives in shared repository administration data unless per-worktree configuration is explicitly enabled.

## Identity and credentials

Resolve `user.name`, `user.email`, `user.useConfigOnly`, signing keys, and repository policy before committing. Do not invent identity, copy another contributor's identity, or expose a personal address in a work repository without direction.

Never place credentials in remote URLs, config values, shell history, scripts, or logs. Use a credential helper appropriate to the host. For GitHub authentication, route to `gh-cli`; do not print `gh auth token` or translate its output into a URL.

Treat `safe.directory` as a trust decision. Investigate ownership first. Never set `safe.directory=*` to suppress a warning.

## Ignore rules

Ignore sources have different ownership:

- `.gitignore` is shared repository policy.
- `.git/info/exclude` is local to one repository clone and shared by its linked worktrees.
- `core.excludesFile` is user-wide policy.

Use `git check-ignore -v -- <path>` to identify the winning rule. Do not ignore a tracked file to make status quiet; ignore rules do not stop tracking. Do not add source, fixtures, lockfiles, or required generated output to an ignore file without understanding repository policy.

## Attributes and line endings

`.gitattributes` controls text normalization, filters, diff/merge drivers, export behavior, and other path policy. Inspect the effective result:

```bash
git check-attr --all -- <path>
git ls-files --eol -- <path>
```

Attribute changes can alter the next checkout or staging operation across many files. A renormalization with `git add --renormalize` is a separate broad mutation. Preview its path set and diff; do not combine it with unrelated work.

Custom clean and smudge filters execute local commands and can change staged or checked-out content. Treat filter configuration from an untrusted repository as code.

## Hooks

Inspect hook ownership and location before a mutation that invokes hooks:

```bash
git config --show-origin --get core.hooksPath
git rev-parse --git-path hooks
```

Hooks are executable code. Read relevant hooks, `core.hooksPath`, repository bootstrap instructions, and any installed-version hook configuration before running them in an untrusted checkout. Recent Git versions can configure hook execution beyond files in the traditional hooks directory, including parallel runs. Never bypass a failing hook with `--no-verify`. A hook that edits files requires a fresh status and diff before any follow-up commit.

Changing `core.hooksPath` can disable security and policy checks. Do not change it to make a command pass.

## Signing and verification

Commit and tag signing policies are separate. Inspect the configured signing format, key, required signatures, and recent verified history. Preserve repository requirements for OpenPGP, SSH, or X.509 rather than substituting a different mechanism.

Verification needs a trust policy, not just a cryptographically valid signature. For SSH signatures, confirm the allowed-signers file and principal mapping. For hosted verification, distinguish local signature validity from the host's identity and vigilant-mode rules.

## Performance configuration

Features such as file-system monitoring, untracked cache, split index, commit graph, and multi-pack index trade compatibility and local state for speed. Measure the problem and check platform support before enabling them. Configuration that affects every clone belongs in repository documentation or bootstrap automation, not an unexplained local tweak.
