# Scrollback and streaming

Use this reference for split-footer applications, captured stdout, structured
scrollback, long command output, streaming Markdown or code, and output replay.

## Choose the output model first

The alternate screen owns a full live grid and preserves the user's prior main
screen. Main-screen mode still reserves a rendered region. Split-footer mode
pins a live footer while ordered output grows above it.

Structured scrollback in the 0.5.10 baseline requires `screenMode:
"split-footer"` with `externalOutputMode: "capture-stdout"`. Captured stdout and
structured commits share one FIFO queue. Do not write around that queue or mix a
second terminal cursor owner into the same region.

Choose between these paths:

- `writeToScrollback()` for one bounded renderable snapshot;
- `createScrollbackSurface()` when one tree must render repeatedly before rows
  are committed;
- ordinary live renderables when content remains interactive and replaceable;
- a file or external pager when retained output exceeds the application's
  memory and replay policy.

## Own a streaming surface

A scrollback surface owns an off-screen render context, root, backing buffer,
committed-row state, and destruction. Keep parsing and producer backpressure
outside the render call. Commit only stable rows, then release source history
that no longer needs replay.

Render before the first commit. A width, terminal size, pixel resolution, or
width-method change can invalidate prior layout. Render again before committing
rows under the new geometry. Destroy the surface after the last commit and on
failure.

`settle()` waits for in-flight Tree-sitter highlighting. It does not prove an
image finished loading or an external producer completed. Await each dependency
through its own contract.

## Keep ordering and memory explicit

- Bound producer queues, retained source text, parser work, and uncommitted
  rows.
- Preserve semantic errors and cancellation even when progress frames are
  replaceable.
- Decide whether a partial last row joins the next commit or ends with a
  newline.
- Rebuild replayable history from application data instead of scraping emitted
  terminal bytes.
- Treat destructive split-footer replay as an explicit user-visible operation.

Solid supplies JSX helpers for one-shot scrollback in the 0.5.10 release. React
does not supply an equivalent JSX writer at that baseline. Use the Core writer
contract instead of deep-importing or inventing a React-only entry point.

## Test output behavior

Use fixed terminal dimensions. Interleave captured stdout and structured writes
to prove FIFO order. Cover partial rows, wrapping, resize before commit,
highlight completion, cancellation, teardown, and unsupported image fallback.
For replay, verify both the retained application model and the visible terminal
result in a pseudo-terminal.

## Review checks

- Screen mode and external output mode support the chosen scrollback API.
- One queue owns ordering between stdout and structured commits.
- Streaming buffers and retained history have limits.
- Resize invalidation forces a fresh render before commit.
- Every surface and framework subtree is disposed after success or failure.
- Long output remains recoverable without keeping an unbounded live tree.
