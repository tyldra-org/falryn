# Simplicity

Minimize the code and mental state required to preserve the right behavior.

## Subtract first

Before adding a layer, flag, validator, or compatibility path, remove dead code,
redundant representations, and obsolete ownership. Design against observed use
and explicit requirements rather than speculative variants.

A smaller diff is preferable only when it solves the whole problem. Do not call
a symptom guard or hidden behavior change “minimal.”

## Reduce reader load

Measure two independent costs:

1. how many layers a reader must traverse to answer a question; and
2. how much mutable or implicit state the reader must retain.

Collapse one-caller wrappers, pass-through adapters, and interfaces that expose
nearly as much complexity as they hide. Adjacent layers should change the
abstraction or enforce a real boundary. Prefer locals over fields, fields over
module state, and derived facts over synchronized copies.

A useful check is whether a new maintainer can find where a value originates,
who may change it, and which invariant protects it without tracing a wide call
graph.

## Abstract only earned repetition

Repeated syntax is not automatically duplicated knowledge. Keep a few explicit
statements when an abstraction would obscure control flow or create a second
concept. Consolidate decisions and invariants that otherwise drift.

Avoid deep signal threading when ownership can move closer to the source. Do not
introduce extension points without a second real implementation or a contract
that requires one.

## Migrate internal APIs decisively

When compatibility is not a public requirement, inventory callers, move them to
the new internal API, update behavior-focused tests, and remove the old path in
the same change. A temporary adapter requires a named external dependency, an
owner, a removal condition, and a bounded lifetime.

Never apply this rule blindly to public, persisted, wire, plugin, or third-party
contracts. Those require an explicit compatibility and migration decision.
