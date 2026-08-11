# api

Use `gh api` and bounded scripts when dedicated commands do not expose the required GitHub capability.

## Prefer the highest-level interface

1. Connected GitHub tool with an exact schema.
2. Dedicated `gh` command.
3. REST through `gh api`.
4. GraphQL through `gh api graphql`.
5. Browser for UI-only settings.

Do not use raw `curl` with copied tokens.

## REST

```bash
gh api repos/OWNER/REPO/issues/123
gh api repos/OWNER/REPO/issues --paginate --slurp
gh api repos/OWNER/REPO/issues/123 -X PATCH -f state=closed
```

Use `-F` for typed values, `-f` for strings, `--input -` for JSON from stdin, and `--hostname` for Enterprise. Inspect response status and body. Follow official endpoint versioning and preview requirements.

## GraphQL

```bash
gh api graphql \
  -f query='query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){id}}' \
  -F owner=OWNER -F repo=REPO
```

GraphQL HTTP success may contain `errors`; check both `data` and `errors`. Paginated queries must accept a cursor and request `pageInfo { hasNextPage endCursor }`.

Treat node IDs, cursors, Project IDs, item IDs, field IDs, option IDs, and iteration IDs as opaque. Resolve them immediately before mutation and reuse exact values.

## Pagination and limits

- Never assume the first page is complete.
- Use `--paginate`; use `--slurp` when a single array is needed.
- Request only fields required by the decision.
- Bound concurrency and preserve ordering where relationships depend on earlier writes.
- Detect truncation by comparing reported totals, page information, and collected counts.

## Repeat-safe bulk workflow

1. Declare exact repositories, object types, filters, desired counts, and write classes.
2. Snapshot current state and stable identities.
3. Compute create/update/link/close/delete sets without writing.
4. Present a dry summary for broad or consequential changes.
5. Execute one write class at a time with bounded concurrency.
6. Record success, skip, failure, and uncertain result per object.
7. Re-read remote state independently.
8. Retry only failed operations whose post-state proves they did not apply.
9. Audit duplicates, omissions, relationships, fields, and counts.

Never make `title` globally unique unless the scope defines it. A safer identity may be repository + parent + exact title, issue number, URL, or node ID.

## Shell and script safety

Prefer a language process API with argument arrays for substantial automation. Do not build shell strings from issue bodies, titles, branch names, paths, or user input.

Materialize Markdown and JSON before mutation. Never pipe an unchecked transformation directly into a mutating `gh` command: if the producer fails while the consumer receives empty stdin, valid remote content can be erased.

For a body replacement:

1. retain the exact old body;
2. generate the candidate into a narrowly scoped temporary file;
3. require a successful producer, non-empty candidate, expected markers, and an inspected diff;
4. pass that validated file to the mutation;
5. re-read and compare the remote body;
6. restore the retained body immediately when authorized if verification fails.

Follow [Remote body and metadata safety](../SKILL.md#remote-body-and-metadata-safety).

Do not create helper scripts containing tokens. Temporary files must contain only nonsecret payloads and should use a narrowly scoped temporary directory.

## Rate limits and partial failure

Inspect rate-limit responses and abuse detection. Back off with bounded retries; do not parallelize hundreds of writes blindly.

For a long batch, emit progress and retain enough identifiers to resume. Separate parent creation from child linking and Project field updates so a failure does not obscure which stage applied.

## API mutation checks

Before using a mutation:

- verify current official schema and required permissions;
- inspect the target and expected old value;
- include optimistic preconditions when the API supports them;
- know whether the operation is idempotent;
- know the exact inverse or recovery path;
- confirm if deletion, publication, permission, visibility, or broad state change is involved.

Afterward, query the public object shape that users and automation consume—not merely the mutation response.
