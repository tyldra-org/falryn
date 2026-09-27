/**
 * The rule both remote hook handlers share (#1174, #1175): a remote hook starts no package
 * code. Its declaration carries no execution or module, must declare the external effect,
 * and may add only observation plus the credential names its handler itself names.
 * Anything broader is refused, not narrowed.
 */
import type { ContributionDeclaration } from "./manifest.ts";

export function isRemoteHookDeclaration(
  declaration: ContributionDeclaration,
  credentials: readonly string[],
): boolean {
  const authority = declaration.authority;
  return (
    declaration.kind === "hook" &&
    declaration.hook !== undefined &&
    declaration.execution === undefined &&
    declaration.module === undefined &&
    authority.effects.includes("external") &&
    authority.effects.every((effect) => effect === "external" || effect === "observation") &&
    authority.permissions.length === 0 &&
    authority.roots.length === 0 &&
    authority.destinations.length === 0 &&
    authority.localData.length === 0 &&
    JSON.stringify(authority.secretReferences) === JSON.stringify(credentials)
  );
}
