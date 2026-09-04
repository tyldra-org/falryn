# Animation and live rendering

Use this reference for Timeline, easing, frame cadence, renderer liveness,
transient motion, and animation tests.

## Separate construction, registration, and playback

In the 0.5.10 API, `new Timeline()` constructs a paused, unregistered timeline.
`createTimeline()` registers it with the global engine and normally starts it.
React and Solid `useTimeline()` register on mount and release on owner cleanup.
Confirm these contracts against the installed release before using them.

Core owners must make all three decisions visible:

- who constructs the timeline and adds items;
- who attaches or relies on the renderer-backed engine;
- who pauses and unregisters the timeline.

A completed factory-created timeline remains registered until its owner removes
it. Do not call `engine.clear()` for component cleanup because it affects other
owners.

## Balance renderer liveness

Use normal demand rendering for state-driven updates. Use `renderer.start()`
only when the whole application needs continuous rendering. Use
`requestLive()` and `dropLive()` as a balanced pair for independently owned live
work.

Registered timelines manage their own live request through the animation
engine. Do not add another `requestLive()` for the same timeline. If an owner
attaches the engine manually, it also owns detachment during shutdown.

## Keep motion bounded

- Animate numeric properties supported by the installed Timeline API.
- Bound timelines, items, loops, and synchronized children.
- Use a positive finite duration and make the timeline long enough for its
  longest item.
- Remove one-shot items after completion when the API offers that behavior.
- Do not perform I/O or expensive parsing from a per-frame update.
- Preserve the final state when motion is disabled or unsupported.

Treat reduced motion as behavior, not a slower duration. Skip decorative motion
or jump to the final state while keeping the command and feedback intact.

Framework hook options are setup-time data in the 0.5.10 baseline. Recreating a
hook owner to apply every changing option can reset animation identity. Drive
ongoing changes through supported timeline methods or explicit application
state.

## Test time directly

Use `ManualClock` from `@opentui/core/testing` where the API accepts the renderer
clock. Advance exact boundaries and assert initial, intermediate, completed,
paused, cancelled, and cleaned-up states without wall-clock sleeps.

Measure frame work and renderer scheduler state for performance claims. An
animation that looks smooth once does not prove it releases liveness or stays
within budget under several simultaneous timelines.

## Review checks

- Timeline construction, registration, playback, and cleanup have one owner.
- Every manual live request has one matching drop on success and failure.
- Registered timelines do not double-request live rendering.
- Loops and item counts have product limits.
- Reduced-motion mode reaches the same meaningful final state.
- Tests use controlled time and verify cleanup after completion and unmount.
