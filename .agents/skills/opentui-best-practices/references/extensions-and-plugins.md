# Extensions and plugins

Plugins and custom renderables run inside or beside a latency-sensitive terminal
host. Validate each contribution before it enters a live registry.

## Define the extension contract

Each extension needs:

- stable identity and a compatible host-version range;
- explicit authority over commands, key bindings, panels, and render layers;
- bounded input, output, memory, and execution time;
- cancellation and failure isolation;
- one owner for registration and cleanup;
- a visible unavailable or degraded state.

Do not let registration order decide which command, key binding, resource, or
render layer wins. Detect conflicts before mounting the extension.

## Roll back partial registration

Return one cleanup function for everything the extension registered:

```ts
type Dispose = () => void;
type Registry<T> = { readonly add: (value: T) => Dispose };
type ExtensionHost = {
  readonly commands: Registry<unknown>;
  readonly keymap: Registry<unknown>;
  readonly panels: Registry<unknown>;
};
type Extension = {
  readonly commands: unknown;
  readonly bindings: unknown;
  readonly panels: unknown;
};

function disposeAll(disposers: readonly Dispose[]): unknown[] {
  const failures: unknown[] = [];
  for (const dispose of disposers.slice().reverse()) {
    try {
      dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function mountExtension(host: ExtensionHost, extension: Extension): () => void {
  const disposers: Dispose[] = [];
  try {
    disposers.push(host.commands.add(extension.commands));
    disposers.push(host.keymap.add(extension.bindings));
    disposers.push(host.panels.add(extension.panels));
  } catch (error) {
    throw new AggregateError(
      [error, ...disposeAll(disposers)],
      "Extension mount failed",
    );
  }

  return () => {
    const failures = disposeAll(disposers);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Extension cleanup failed");
    }
  };
}
```

If cleanup can be asynchronous, make the disposal contract asynchronous from
the start and await all registered cleanup before reporting shutdown complete.

## Protect the host

Extension callbacks must not block input or rendering. Schedule external work
behind a bounded owner and project results into state. Reject contributions that
escape size, time, capability, or naming limits.

Keep custom renderables responsible for their buffers, dirty state, hit regions,
and disposal. Do not give a plugin unrestricted renderer mutation when a narrow
panel or command contract is sufficient.

## Change compatibility deliberately

When an OpenTUI or host upgrade changes extension contracts, migrate registered
extensions and tests together. Remove obsolete adapters after their final
caller moves unless the product intentionally supports multiple versions.

## Review checks

- Identity and compatibility are checked before registration.
- Conflicting commands, keymaps, and render layers fail explicitly.
- Partial registration rolls back in reverse order.
- Cleanup failure remains visible and does not stop later cleanup.
- Extension work has cancellation, time, memory, and output bounds.
- Plugins cannot mutate more renderer state than their contract grants.
