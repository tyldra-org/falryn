# Runtime and package selection

Use this reference before choosing a runtime, binding, package entry point,
integration package, or release target.

## Resolve the installed set

Read `package.json`, the lockfile, published package metadata, and installed
exports together. Keep Core, React or Solid, Keymap adapters, test helpers, and
native artifacts on a compatible release set. Workspace manifests can differ
from published manifests, so verify the package consumers actually install.

This reference was audited against OpenTUI 0.5.10. At that release:

- Core runs on Bun 1.3.0 or later. Its Node path needs Node.js 26.4.0 or later,
  ESM, and `--experimental-ffi`.
- React requires React 19.2.0 or later.
- Solid requires exactly Solid 1.9.12.
- runtime-module support and `@opentui/three` are Bun-only.
- published native packages are internal distribution details, not application
  APIs.

Recheck the official runtime-support and package-entry-point pages for the
installed version. Do not copy these numbers into a project without confirming
its release.

The clean 0.5.10 audit also found that its published declarations do not pass a
TypeScript 7.0.2 check with `skipLibCheck: false`. The failures are inside Core
event declarations and React declaration dependencies. Treat independently
latest package tags as candidates, not proof of compatibility. Follow the
project's supported TypeScript range or track the upstream mismatch. Do not
weaken an existing declaration-checking policy without making that tradeoff
explicit.

## Choose the owning package

- `@opentui/core` owns the renderer, imperative renderables, input, buffers,
  terminal features, plugin registries, Tree-sitter integration, and shared
  types.
- `@opentui/react` owns the React root, intrinsics, hooks, components, and React
  plugin slots.
- `@opentui/solid` owns the Solid renderer, intrinsics, hooks, test rendering,
  Solid plugin slots, and Solid scrollback helpers.
- `@opentui/keymap` owns host-independent commands, binding layers, sequences,
  queries, and addons. Use its OpenTUI, React, or Solid entry point for the host
  adapter.
- `@opentui/qrcode` owns encoding and QR renderables.
- `@opentui/ssh` owns the SSH server and remote-session transport. Each session
  still needs its own renderer and binding root.
- `@opentui/three` owns WebGPU and Three.js integration and requires Bun plus its
  graphics dependencies.

Use only package roots and subpaths listed by the installed release. Do not
deep-import source files, platform packages, generated native paths, or a value
that happens to exist in a workspace build.

## Match runtime and build form

Choose source execution, a JavaScript bundle, a Bun executable, Node.js SEA, or
an SSH host before designing asset lookup. Each form changes which native
library, parser worker, grammars, WASM files, plugins, and optional media must be
available.

Importing Core can succeed before the native library loads. Exercise
`createCliRenderer()` in the target artifact to prove the FFI path and native
asset. Test each claimed operating system, CPU, and Linux libc. Published files
do not establish runtime parity on every target.

## Keep Bun-only paths contained

Runtime-loaded TypeScript modules use Bun-specific support entry points. Install
one support layer for the host binding. React and Solid support already include
Core. Do not install both a framework support layer and the Core layer in one
process.

Node stubs for Bun-only entry points fail during import. Keep those imports out
of Node builds instead of catching the failure at runtime.

## Review checks

- All OpenTUI packages and peers form a supported set.
- The TypeScript compiler and declaration-checking policy are compatible with
  the selected OpenTUI release.
- Every import is a published entry point for the installed release.
- The selected runtime can execute the binding, native FFI, and optional
  integrations.
- The final artifact contains the matching native and parser assets.
- Bun-only modules are absent from Node.js paths.
- A real renderer starts and shuts down on every claimed target.
