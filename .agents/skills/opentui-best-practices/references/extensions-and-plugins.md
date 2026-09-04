# Extensions and plugins

Use this reference for typed plugin slots, runtime-loaded modules, custom
renderables supplied by extensions, registration conflicts, and plugin cleanup.

## Separate the three contracts

OpenTUI exposes related mechanisms with different authority:

- plugin slots let a host define typed regions and accept contributions;
- runtime-module support lets a Bun host import trusted external modules while
  sharing the host's Core, React, Solid, and related singleton packages;
- custom renderables add drawing behavior and native ownership to a render tree.

Plugin slots do not discover packages, parse manifests, sandbox code, grant
permissions, or define a complete application plugin lifecycle. Runtime loading
does not decide which UI regions a module may change. Keep discovery, trust,
loading, registration, contribution, and disposal as separate steps.

## Keep slot authority with the host

The host owns slot names, prop types, shared context, layout, ordering, modes,
fallbacks, and error policy. A plugin returns only the node type accepted by the
chosen Core, React, or Solid registry.

Registries are scoped to one renderer and key. Reusing the same pair returns the
same registry in the 0.5.10 baseline. The shared context must keep the same
object identity. Create and register only while the renderer is live. After
asynchronous loading, check renderer lifetime again before mutation.

Each registration returns an unregister function. Renderer destruction clears
its registries and runs registered plugin disposal. Framework slot components
also release their subscriptions and contribution subtrees through their own
owner cleanup.

## Define a bounded plugin contract

Require:

- stable identity and a compatible host-version range;
- named slot contributions and explicit host context;
- input, output, memory, and execution limits;
- cancellation and failure isolation;
- one registration owner and one disposal path;
- a visible unavailable or degraded result.

Detect duplicate identities and conflicting contributions before mounting.
Make ordering data explicit. Do not let import order decide which plugin wins.

Buffer plugin errors with a fixed limit and route them to host diagnostics.
Failure placeholders must be simpler and safer than the contribution they
replace. A placeholder failure cannot take down the host error path.

## Load trusted modules through one runtime layer

Runtime-module support is Bun-only in OpenTUI 0.5.10. Choose the support package
for the host binding. React and Solid support already include Core. Installing
both a framework support layer and Core support creates competing global setup.

Use the configurable installer when the host must add or replace mapped module
specifiers. Keep the map narrow. A package absent from the host map remains the
plugin's deployment responsibility. Node stubs for runtime support throw during
import and are not a compatibility path.

Treat runtime-loaded code as trusted code unless the application adds a real
process, permission, or operating-system isolation boundary. Type validation and
a narrow slot contract reduce mistakes. They do not sandbox a module.

## Keep custom renderables contained

A plugin-provided renderable owns its buffers, dirty state, clipping, hit
regions, layout inputs, retained native resources, and disposal. Do not grant
unrestricted renderer mutation when a slot or command contribution is enough.
Keep I/O and expensive preparation out of drawing and event handlers.

## Test registration and failure

Cover duplicate registration, ordering, each slot mode, initial contribution
failure, later subtree failure, placeholder failure, unregistration, renderer
destruction, and partial plugin setup. Runtime-loading tests must use the built
artifact and deployed sidecars rather than source-only imports.

## Review checks

- Discovery, loading, slot registration, and disposal have separate owners.
- The host controls layout, context, ordering, and failure policy.
- Renderer lifetime is checked after asynchronous loading.
- Every registration is removable and renderer destruction clears the rest.
- Runtime-module support is installed once for the owning Bun binding.
- Untrusted code is not mislabeled as sandboxed.
- Custom renderables cannot mutate more terminal state than their contract
  requires.
