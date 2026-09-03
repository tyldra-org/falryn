# OpenTUI troubleshooting practices

Do not guess API names from React DOM, CSS, terminal libraries, or older OpenTUI releases.

## Sequence

1. Record installed package versions, runtime, OS, terminal, color/capability environment, and the smallest failing action.
2. Read the exact pinned MDX owner and installed exported types.
3. Reproduce with the documented test renderer when the failure does not require a real terminal.
4. Classify: renderer lifecycle, input/focus, layout/resize, component contract, framework reconciliation, native asset/data path, plugin, packaging, or terminal capability.
5. Change one owner and rerun the focused reproduction plus cleanup checks.

## Common evidence

- Captured character/frame output for rendering differences.
- Explicit focus target and keyboard/paste event sequence for input bugs.
- Width, height, Yoga constraints, and resize sequence for layout bugs.
- Renderer/root/plugin creation and disposal order for hangs or terminal corruption.
- Resolved native asset, worker, parser, and package entrypoint paths for packaged failures.
- Terminal capability and environment-variable values using the exact names in pinned docs.

## Stop conditions

Stop rather than patch around:

- a package/docs version mismatch;
- an API absent from installed exports;
- cleanup that depends on forced process exit;
- unbounded synchronous work in rendering or input;
- a native packaging failure not reproduced on the affected platform;
- a plugin failure whose process or resource ownership is unknown.
