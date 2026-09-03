# Design

Shape the system around the experience and domain, not the order in which code
happens to execute.

## Start from the outcome

Describe success from the consumer's seat: end user, API caller, operator, and
next maintainer. Features, controls, layers, and configuration must earn their
place by improving that outcome. Prefer a smaller polished core loop to a wider
rough surface.

Before scaffolding, remove dead paths and redundant concepts. Foundations are
valuable when they make every later unit simpler; otherwise they are speculative
weight.

## Model the domain

Choose data structures before control flow:

- state machines or sum types instead of synchronized booleans;
- semantic IDs or branded primitives instead of interchangeable strings;
- registries or lookup tables instead of repeated branching;
- commands and events instead of scattered mutation;
- queues, indexes, graphs, or normalized collections only when access patterns
  require them.

Make illegal states hard or impossible to construct. Derive types from the
canonical schema rather than maintaining a parallel hand-written shape. Match
variants exhaustively. Do not use casts to hide a missing proof.

Strengthen types where an operation would otherwise be partial or ambiguous,
not merely to maximize precision. A type that adds ceremony without excluding a
real failure is not stronger engineering.

## Keep boundaries honest

Treat CLI input, configuration, persisted bytes, network protocols, process
output, and external APIs as untrusted until parsed. Convert them once into a
framework-independent domain representation and keep transport or framework types
at the edge.

Internal typed values may be trusted only while their authority remains valid.
Generation changes, stale caches, mutable external state, privilege changes, and
security-sensitive transitions are new boundaries and require revalidation.
Keep business logic pure where practical so adapters remain mechanical.

## Explore only meaningful alternatives

For a novel interaction or architecture with several plausible shapes, produce
two or three materially different sketches or prototypes and compare them
against the outcome, constraints, failure modes, and maintenance cost. Variants
of the same shape do not count.

Skip design fan-out when the repository already has a proven pattern or the
constraints leave one viable implementation.

## Integrate from first principles

When a new requirement changes a foundational assumption, ask what the design
would look like had that requirement existed from the start. Propagate the
answer through types, ownership, callers, persistence, tests, and documentation.
Deliver that redesign in green, reviewable units rather than attaching a
permanent compatibility side path.
