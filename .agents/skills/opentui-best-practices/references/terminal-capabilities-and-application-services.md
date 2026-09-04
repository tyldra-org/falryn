# Terminal capabilities and application services

Use this reference for colors, keyboard protocols, image support, clipboard,
notifications, audio, audio capture, and other terminal or operating-system
services exposed through OpenTUI.

## Ask the renderer what is supported

Base behavior on the installed release's terminal-capability model, current
pixel geometry, and renderer state. Do not infer support from `TERM`, brand
names, or one development terminal alone.

Treat `supported`, `unsupported`, and `unknown` as different states. Unknown
capability should take the safe fallback until direct use proves otherwise. In
tests, construct complete capability fixtures and override only the fact under
test.

Semantic state cannot depend on color depth, a glyph width, animation, image
protocol, sound, or desktop integration. Preserve the same result in text and
use optional services for richer feedback.

## Keep service effects behind commands

Clipboard writes, notifications, audio playback, and capture are effects. Put
them behind a command or service boundary so domain behavior and UI state remain
testable without the terminal or operating-system integration.

Define for each service:

- the capability and permission check;
- input size, format, and duration limits;
- cancellation and timeout behavior;
- user-visible success, denial, and unavailable states;
- the owner that releases handles, streams, buffers, and listeners.

Do not report success before the service's contract confirms it. A notification
request or clipboard escape written to the terminal is not proof that the user
received the result.

## Protect sensitive data

Clipboard and capture APIs can move data outside the rendered application.
Require a user action for sensitive writes or recording. Bound retained audio
and image data, avoid logging payloads, and clear temporary buffers when their
owner finishes.

Treat terminal replies and clipboard reads as external input. Parse them at the
renderer boundary and keep timeouts so an unsupported terminal cannot block the
application.

## Own streaming media

Audio playback and capture need bounded queues. Decide whether overflow drops,
backpressures, or cancels, then expose that outcome. Stop producers before
closing native outputs. Release devices and callbacks after partial startup,
normal completion, cancellation, and renderer destruction.

Images and other pixel-based content need current terminal geometry. Await the
resource's own load contract before rendering or committing it to scrollback.
Keep a text or block fallback when the image protocol or build lacks support.

## Verify on the real target

Use test capabilities for deterministic fallback logic, then verify supported
services in the actual terminal, operating system, SSH client, or packaged
artifact. Record which target established the claim. One terminal's behavior
does not qualify every published platform.

## Review checks

- Capability detection comes from the renderer or tested service contract.
- Unsupported and unknown states keep the same essential outcome.
- Sensitive clipboard and capture effects require an intentional user action.
- Queues, payloads, and durations have bounds.
- Native handles and callbacks close on every exit path.
- Target-specific claims name the terminal, operating system, and artifact that
  was exercised.
