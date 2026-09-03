# OpenTUI implementation practices

Start with the exact MDX for every API. This page only helps choose boundaries.

## Framework choice

- Use Core when direct renderable ownership, minimal abstraction, or custom renderer integration is the requirement.
- Use React or Solid when the existing application already uses that reconciler or declarative component composition materially helps.
- Do not mix framework roots or manually mutate framework-owned renderables without a documented ownership boundary.

## Structure

- Keep renderer creation and destruction under one visible owner.
- Separate domain state from rendering state so tests can exercise behavior without a terminal.
- Keep input mapping distinct from actions; keymaps should resolve intent before effects execute.
- Treat focus, paste, selection, resize, scroll, and terminal capability changes as state transitions with explicit fallback behavior.
- Use layout constraints rather than terminal-size guesses, and test representative narrow and wide frames.
- Keep work that can block, stream, or fail outside the synchronous render and keystroke path. Bound queues and expose progress or cancellation where appropriate.

## Framework components

- Follow the binding MDX for intrinsic elements, hooks, refs, cleanup, and test helpers.
- Keep effects and subscriptions scoped to the component/root that owns them.
- Use stable keys for reorderable children.
- Prefer documented component props and nested text modifiers over guessed DOM or CSS conventions.

## Packaging

Native assets, workers, parsers, plugins, media, and standalone executables have explicit data-path and deployment contracts. Read the matching `docs/reference/` and `docs/ship/` pages and validate the built artifact on each supported target.
