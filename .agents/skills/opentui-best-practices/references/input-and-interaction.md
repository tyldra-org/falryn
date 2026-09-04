# Input and interaction

Turn terminal events into deterministic intent before running effects.

## Resolve commands before effects

Parse keyboard, paste, and mouse input at the host boundary. Map the event to a
command using the active context, then decide whether that command is available.
The effect handler should not reinterpret raw escape sequences or duplicate
keymap precedence.

Layer bindings from most specific active context to the application context.
Detect conflicts instead of letting registration order decide. Text controls
must retain ordinary character input while keeping deliberate navigation,
cancellation, and submission commands reachable.

Use direct keyboard events when one owner needs the original event. Use a
component's binding options for local editing or selection behavior. Use
`@opentui/keymap` when commands span views, need focus-scoped precedence, support
sequences or user configuration, or drive a command palette and shortcut help.

A direct handler should stay small and name one global intent. Verify event
fields for the installed binding:

```tsx
import { useKeyboard } from "@opentui/react";

function useInterrupt(dispatch: (command: "interrupt") => void): void {
  useKeyboard((event) => {
    if (event.name !== "c" || !event.ctrl) return;
    event.preventDefault();
    dispatch("interrupt");
  });
}
```

Do not rebuild a layered command engine from registration order. Read
[Keymaps and commands](keymaps-and-commands.md) for shared commands and
precedence.

## Own focus explicitly

Maintain one reachable focus order for the current UI state. When a region
disappears, move focus to a predictable surviving neighbor. An overlay contains
focus and restores it to the prior region when possible.

Selection, scrolling, and focus are related but distinct. Do not use one hidden
index to represent all three. Ensure the focused or selected item remains
visible after movement and resize.

## Treat paste and mouse as bounded input

Paste may contain multiple lines, control characters, or more data than an
interactive field should retain. Validate and bound it before changing state.
Large input should have an explicit preview, attachment, rejection, or truncation
contract rather than silent loss.

Bound bytes before decoding or changing controlled state:

```tsx
import { usePaste } from "@opentui/react";

const MAX_PASTE_BYTES = 64 * 1024;

function useBoundedPaste(
  applyPaste: (text: string) => void,
  showNotice: (message: string) => void,
): void {
  usePaste((event) => {
    event.preventDefault();
    if (event.bytes.byteLength > MAX_PASTE_BYTES) {
      showNotice("Paste is larger than 64 KiB.");
      return;
    }

    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(event.bytes);
      applyPaste(text);
    } catch {
      showNotice("Paste is not valid UTF-8.");
    }
  });
}
```

Do not replace invalid bytes or silently turn oversized input into a partial
paste.

Mouse behavior depends on layout and hit regions from the rendered frame. Ignore
events outside the current frame or for regions no longer active. Drag,
selection, and wheel behavior need cancellation and boundary tests.

## Keep interaction understandable

Expose available commands and current bindings from the same registry that
dispatches them. Disabled actions should state why they are unavailable. Do not
make escape, interrupt, or shutdown behavior depend on an invisible focus state.

Reduced-motion, low-color, narrow-screen, and keyboard-only operation must
preserve the same outcomes even when presentation changes.

## Review checks

- Keymap precedence follows active context, not registration timing.
- Text entry, global commands, overlays, and focused controls cannot
  double-handle one event.
- Focus has a valid destination after removal, resize, and overlay dismissal.
- Paste, mouse coordinates, wheel input, and repeated keys have explicit bounds.
- Help and disabled-action messages come from the same command registry as
  dispatch.
- Escape, interrupt, cancellation, and shutdown remain reachable in every focus
  state.
