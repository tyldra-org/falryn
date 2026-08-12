---
name: typescript-best-practices
description: Apply TypeScript engineering practices across TypeScript, JavaScript, TSX, React, and Next.js. Use when implementing, refactoring, debugging, reviewing, documenting, or configuring TypeScript—especially type errors, tsconfig, advanced types, compiler performance, migrations, monorepos, React/Next typing, JSDoc/TypeDoc, or scaffolding.
---

# TypeScript Best Practices

Router for focused TypeScript guidance. Modules below are bundled resources, not separate skills.

## Rules

1. Inspect the repo's existing `tsconfig`, scripts, and conventions before changing code.
2. Pick **one** primary guide from the routing table. Read only that entrypoint plus the linked sections you need.
3. Add a second guide only for a distinct cross-cutting concern. Prefer the more specific guide on overlap.
4. Validate with the repo's typecheck, test, lint, and build commands. Do not invent tooling.
5. Do not load every module. Progressive disclosure beats bulk context.

## Routing

| Task | Primary guide |
| --- | --- |
| Everyday `.ts` / `.tsx` / `.js` / `tsconfig.json` idioms | `modules/typescript-best-practices/GUIDE.md` |
| `tsc` performance, type errors, async/module/memory rules | `modules/typescript/GUIDE.md` |
| Generics, conditional, mapped, or template-literal types | `modules/typescript-advanced-types/GUIDE.md` |
| Branded types, type guards, utility types, type-safe API patterns | `modules/typescript-pro/GUIDE.md` |
| Migrations, monorepos, diagnostics, tooling strategy | `modules/typescript-expert/GUIDE.md` |
| JSDoc, TypeDoc, ADRs, API docs | `modules/typescript-docs/GUIDE.md` |
| React + TypeScript review, hooks, state, anti-patterns | `modules/typescript-react-reviewer/GUIDE.md` |
| Next.js App Router, RSC, Shadcn/Radix/Tailwind + TS | `modules/nextjs-react-typescript/GUIDE.md` |
| Scaffolding, tsconfig presets, architecture templates | `modules/typescript-toolkit/GUIDE.md` |

## Ownership (no duplication)

| Concern | Canonical home |
| --- | --- |
| Illegal states, Zod, exhaustive `never`, const assertions | idioms (`typescript-best-practices`) |
| Rule catalog by impact (`type-`, `tscfg-`, `async-`, …) | compiler (`typescript`) |
| Type-system tutorials and worked examples | advanced-types |
| Implementation patterns and reference deep-dives | pro |
| Diagnose / migrate / monorepo / tool choice | expert |
| Documentation tooling and ADR templates | docs |
| React review checklists | react-reviewer |
| Next.js conventions | nextjs |
| Scripts, presets, scaffolds | toolkit |

## Common pairings

- React type bug → idioms, then react-reviewer if review-shaped
- Slow `tsc` / deep instantiation → compiler, then expert diagnostics if stuck
- Complex generic library types → advanced-types, then pro patterns
- Next.js + type performance → nextjs, then compiler
- Monorepo migration → expert, then docs for public API surface
