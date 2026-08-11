---
name: typescript-best-practices
description: Apply TypeScript engineering practices across TypeScript, JavaScript, TSX, React, and Next.js. Use when implementing, refactoring, debugging, reviewing, documenting, or configuring TypeScript, especially for type errors, tsconfig, advanced types, compiler performance, migrations, and monorepos.
---

# TypeScript Best Practices

Use this entrypoint to select one focused guide. The modules, scripts,
templates, and references below are bundled resources, not separate skills.

## Workflow

1. Read the repository guidance and inspect the affected package, `tsconfig`,
   and existing checks before changing code.
2. Choose one primary guide from the routing table.
3. Read its entrypoint and only the linked sections needed for the task.
4. Add a second guide only for a distinct cross-cutting concern; prefer the
   more specific guide if guidance overlaps.
5. Validate with the repository's focused typecheck, tests, lint, and build
   commands; do not invent project tooling.

## Routing

| Task | Primary guide |
| --- | --- |
| Everyday `.ts`, `.tsx`, `.js`, or `tsconfig.json` work | `modules/typescript-best-practices/GUIDE.md` |
| Type errors, module layout, async patterns, or `tsc` performance | `modules/typescript/GUIDE.md` |
| Conditional, mapped, template-literal, or reusable utility types | `modules/typescript-advanced-types/GUIDE.md` |
| Branded types, type guards, discriminated unions, or tRPC | `modules/typescript-pro/GUIDE.md` |
| Large migrations, monorepos, compiler failures, or tooling strategy | `modules/typescript-expert/GUIDE.md` |
| JSDoc, TypeDoc, API documentation, or TypeScript ADRs | `modules/typescript-docs/GUIDE.md` |
| TypeScript + React review, hooks, state, or maintainability | `modules/typescript-react-reviewer/GUIDE.md` |
| Next.js App Router, React, Shadcn, Radix, or Tailwind | `modules/nextjs-react-typescript/GUIDE.md` |
| Extended architecture guidance, scripts, templates, or presets | `modules/typescript-toolkit/GUIDE.md` |

## Common pairings

- React type issue: general guide, then compiler/type-performance guidance if needed.
- Advanced React review: React-review guide, then advanced-types guidance.
- Next.js type-performance issue: Next.js guide, then compiler/type-performance guidance.
- Monorepo API migration: expert guide, then documentation guidance.
