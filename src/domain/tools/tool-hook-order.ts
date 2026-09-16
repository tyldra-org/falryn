/** Dependencies constrain eligible hooks; source rank breaks ties without granting authority. */
export const HOOK_SOURCE_ORDER = [
  "builtin",
  "user",
  "workspace",
  "session",
  "process",
  "development",
] as const;
export type HookOrderMetadata = {
  readonly owner?: string;
  readonly source?: (typeof HOOK_SOURCE_ORDER)[number];
  readonly after?: readonly string[];
};
type OrderedHook = HookOrderMetadata & {
  readonly id: string;
  readonly point: string;
  readonly priority: number;
};
export function hookIdentity(hook: Pick<OrderedHook, "id" | "owner">): string {
  return hook.owner ? `${hook.owner}/${hook.id}` : hook.id;
}
function bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
export function resolveHookOrder<T extends OrderedHook>(
  hooks: readonly T[],
): {
  hooks: T[];
  error?: {
    code: "invalid-hook-declaration" | "missing-hook-dependency" | "hook-dependency-cycle";
    id: string;
  };
} {
  const invalid = hooks.find(
    (hook) =>
      (hook.owner !== undefined && !/^[a-z][a-z0-9._-]{0,63}$/u.test(hook.owner)) ||
      !HOOK_SOURCE_ORDER.includes(hook.source ?? "builtin") ||
      (hook.after !== undefined &&
        (!Array.isArray(hook.after) ||
          hook.after.length > 32 ||
          new Set(hook.after).size !== hook.after.length ||
          hook.after.some((id) => typeof id !== "string" || id.length > 129))),
  );
  if (invalid) return { hooks: [], error: { code: "invalid-hook-declaration", id: invalid.id } };
  const byId = new Map(hooks.map((hook) => [hookIdentity(hook), hook]));
  for (const hook of hooks) {
    if (hook.after?.some((id) => byId.get(id)?.point !== hook.point))
      return { hooks: [], error: { code: "missing-hook-dependency", id: hookIdentity(hook) } };
  }
  const pending = [...hooks];
  const resolved: T[] = [];
  const done = new Set<string>();
  while (pending.length) {
    const eligible = pending.filter((hook) => hook.after?.every((id) => done.has(id)) ?? true);
    eligible.sort(
      (a, b) =>
        bytes(a.point, b.point) ||
        b.priority - a.priority ||
        HOOK_SOURCE_ORDER.indexOf(a.source ?? "builtin") -
          HOOK_SOURCE_ORDER.indexOf(b.source ?? "builtin") ||
        bytes(`${a.owner ?? "builtin"}/${a.id}`, `${b.owner ?? "builtin"}/${b.id}`) ||
        bytes(a.id, b.id),
    );
    const next = eligible[0];
    if (!next)
      return {
        hooks: [],
        error: {
          code: "hook-dependency-cycle",
          id: pending[0] ? hookIdentity(pending[0]) : "registry",
        },
      };
    resolved.push(next);
    done.add(hookIdentity(next));
    pending.splice(pending.indexOf(next), 1);
  }
  return { hooks: resolved };
}
