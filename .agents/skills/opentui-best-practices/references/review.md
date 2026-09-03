# OpenTUI review checklist

Use with `change-review` and the exact MDX pages for changed APIs.

## Correctness

- Renderer, framework root, plugins, servers, workers, subscriptions, and native resources have one visible owner and documented cleanup.
- Input, focus, paste, selection, keymap, and resize transitions reach the intended target and have bounded fallbacks.
- Layout works at representative narrow, wide, and resized dimensions.
- Component props, defaults, event names, hooks, test helpers, environment variables, and package entrypoints match pinned docs and installed exports.
- Async work does not block host-owned keystrokes or rendering and has cancellation/settlement behavior.

## Failure behavior

- Startup failure restores the terminal.
- Error, empty, loading, unavailable, and cancelled states remain visible.
- Repeated mount/unmount or reload does not leak listeners, timers, roots, native handles, or plugin processes.
- Packaged binaries can resolve every required asset and native dependency on supported targets.

## Tests

- Use the documented test renderer and capture methods rather than invented snapshot APIs.
- Exercise interaction through documented mock input helpers or exact event contracts.
- Cover resize, focus transfer, scrolling, and cleanup when affected.
- Keep real-terminal or platform smoke tests for behavior the test renderer cannot prove.

A finding must cite the changed code, installed/pinned contract, reachable consequence, and focused fix. Do not report framework preference or arbitrary component-size thresholds as correctness defects.
