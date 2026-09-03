# Packaging and runtime resources

Treat every file outside ordinary TypeScript modules as an explicit runtime
dependency.

## Resolve packaged resources

Inventory native libraries, parsers, queries, workers, fonts, images, media, and
other data files used at runtime. Resolve them through the package or
executable's supported data-path contract. Source-relative paths and
current-working-directory assumptions often fail after installation.

Put resource discovery behind a small boundary so source and packaged tests can
use different resolvers without changing rendering code:

```ts
type SyntaxService = { readonly close: () => Promise<void> };
type OpenSyntaxService = (paths: {
  readonly parserPath: string;
  readonly queryPath: string;
  readonly workerPath: string;
}) => Promise<SyntaxService>;

export type RuntimeResources = {
  readonly resolve: (name: "parser" | "queries" | "worker") => string;
};

export async function loadSyntax(
  resources: RuntimeResources,
  open: OpenSyntaxService,
): Promise<SyntaxService> {
  return open({
    parserPath: resources.resolve("parser"),
    queryPath: resources.resolve("queries"),
    workerPath: resources.resolve("worker"),
  });
}
```

The production resolver should use the installed OpenTUI release's supported
runtime-resource API. Run its packaging test from the built artifact while the
source checkout is absent from the working directory.

## Own native and remote sessions

Native resources need explicit cleanup after success, partial startup, failure,
and interruption. A successful TypeScript build does not prove that a native
binary loads or that an asset was embedded, copied, executable, or discoverable.

An SSH session owns its renderer, dimensions, input, output, subscriptions, and
disconnect cleanup. Do not share mutable renderer state or focus between
clients.

Audio, images, animation, and post-processing must degrade when the terminal or
build lacks support. Bound queues and buffers, release native handles, and keep
essential state available as text.

## Upgrade as one compatible set

Inspect the lockfile and installed exports before upgrading. Keep Core, the
chosen binding, keymap packages, native assets, and test helpers on a compatible
set. Do not hide version mismatches behind casts or local declarations.

Run typechecking and focused renderer tests first. Then build and launch the
produced artifact on each claimed operating-system and CPU target.

## Prove distribution behavior

Test installation, first launch, repeated launch, clean shutdown, interruption,
missing optional resources, and unsupported capabilities from the produced
artifact. Report platform gaps as unsupported or unverified. Source-mode tests
do not qualify a packaged application.

## Review checks

- Every native file, query, worker, font, and media asset has a packaged resolver.
- Tests run outside the source working directory and fail when an asset is absent.
- Native handles and remote sessions have one cleanup owner.
- SSH sessions do not share dimensions, focus, streams, or renderer state.
- Optional media retains a usable text fallback.
- Platform claims come from produced-artifact evidence.
