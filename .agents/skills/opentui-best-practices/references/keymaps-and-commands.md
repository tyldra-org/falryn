# Keymaps and commands

Use this reference when actions span views, bindings depend on focus or mode,
users can rebind keys, or the UI exposes command and shortcut discovery.

## Choose the input level

Keep a direct keyboard handler when one owner needs the original event. Keep
cursor movement, selection, and editing bindings inside the component that owns
that behavior. Use `@opentui/keymap` when the same named command belongs to
several contexts or needs layered precedence, sequences, leader keys, user
configuration, a command palette, or generated help.

Keymap does not replace text input. It coordinates application commands around
focused components and can adopt editing addons only when the product needs one
central binding model.

## Register commands once

Create the renderer first, then create the OpenTUI host adapter and register
layers. The default factory installs the standard parser and common fields. Use
the bare factory only when the application deliberately owns those pieces.

```ts
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";

const keymap = createDefaultOpenTuiKeymap(renderer);
const unregister = keymap.registerLayer({
  priority: 10,
  commands: [{ name: "workspace.save", run: () => saveWorkspace() }],
  bindings: [{ key: "mod+s", cmd: "workspace.save" }],
});

try {
  await runApplication();
} finally {
  unregister();
}
```

Confirm field names and command return behavior against the installed package.
The host owns the Keymap lifetime. Keymap has no independent public destroy
method. Renderer destruction releases host listeners and pending input.

## Make precedence explicit

A targetless layer is global. A targeted layer follows the focused target and
its parent path unless the layer requests exact focus. Higher priority runs
first, and newer registration breaks equal-priority ties. Do not rely on that
tie as hidden policy. Give product-significant layers distinct priorities or
reject conflicting bindings during configuration.

Clear or reinterpret pending sequences when focus, mode, or configuration
changes. Bound sequence length and timeout through the installed addon contract.
Do not allow a half-entered sequence to trap quit, interrupt, or recovery keys.

## Derive help from live state

Build command palettes, shortcut hints, and leader-key prompts from Keymap query
results. Do not maintain a second static list. Disabled commands should retain
their identity and explain why they cannot run.

React and Solid adapters connect one stable Keymap instance through their
provider and hooks. Register a layer in the framework owner that also releases
it. Do not recreate the Keymap on every render or reactive update.

## Test without a renderer when possible

Use `createTestKeymap()` from `@opentui/keymap/testing` for command resolution,
focus paths, sequences, diagnostics, target destruction, and addon behavior.
Use the OpenTUI test renderer only when the contract depends on real component
focus, terminal input parsing, or integration with a renderable.

## Review checks

- Each application action has one named command.
- Layer activation and priority match visible focus and mode.
- User overrides are parsed, validated, and conflict-checked before activation.
- Help and command palettes come from the live registry.
- Pending sequences cannot hide cancellation or shutdown.
- Every layer registration has a disposer owned by the same lifecycle.
