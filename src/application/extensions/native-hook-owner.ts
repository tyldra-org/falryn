import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { hookCommandContract } from "../../domain/extensions/hook-command-profile.ts";
import { contributionDeclarationSchema } from "../../domain/extensions/manifest.ts";
import {
  isToolHookPoint,
  type ToolHookContext,
  type ToolHookDecision,
  type ToolHookEnvelope,
} from "../../domain/tools/tool-hooks.ts";
import type { NativeRegistrationOwner } from "./native-registration.ts";

export const PACKAGE_HOOK_OWNER = "falryn-hook-registry-v1";
export type PackageHookInvocation = {
  packageId: string;
  expectedRevision: number;
  contribution: string;
  activation: string;
  envelope: ToolHookEnvelope;
  context: ToolHookContext;
};
export function createNativeHookOwner(options: {
  qualified(): boolean;
  execute(input: PackageHookInvocation): Promise<ToolHookDecision>;
}): NativeRegistrationOwner {
  return {
    id: PACKAGE_HOOK_OWNER,
    kind: "hook",
    register({ entry, contribution, activation, generation, hookGeneration }) {
      try {
        if (!options.qualified())
          throw new ExtensionInputError("hook-execution-profile-unavailable");
        if (entry.source.kind !== "package") throw new ExtensionInputError("hook-package-required");
        const declaration = contributionDeclarationSchema.parse(contribution.declaration);
        const packageId = entry.source.owner.packageId;
        const registration = hookCommandContract(declaration);
        if (!isToolHookPoint(registration.point))
          throw new ExtensionInputError("hook-publisher-unavailable");
        const owner = `p${canonicalDigest({ packageId: entry.source.owner.packageId, scope: activation.scopeKey }).slice(7, 70)}`;
        const identity = (namespace: string, id: string) =>
          `h${canonicalDigest({ namespace, id }).slice(7, 70)}`;
        const id = identity(contribution.identity.namespace, contribution.identity.localId);
        const hook = {
          id,
          owner,
          source: activation.authority.scope,
          point: registration.point,
          registration,
          priority: registration.priority ?? 0,
          after: (registration.after ?? []).map((dependency) => {
            const parts = dependency.split("/");
            if (parts.length > 2) throw new ExtensionInputError("hook-dependency-invalid");
            return `${owner}/${identity(parts.length === 2 ? (parts[0] ?? "") : contribution.identity.namespace, parts.at(-1) ?? "")}`;
          }),
          run: (envelope: ToolHookEnvelope, context: ToolHookContext) =>
            options.execute({
              packageId,
              expectedRevision: activation.installedRevision,
              contribution: contribution.identityDigest,
              activation: canonicalDigest(activation),
              envelope,
              context,
            }),
        };
        return {
          status: "registered",
          hook,
          binding: {
            version: 1,
            contributionIdentityDigest: contribution.identityDigest,
            extensionActivationDigest: canonicalDigest(entry.source.activation),
            nativeRegistryOwner: PACKAGE_HOOK_OWNER,
            nativeRegistryGeneration: Number(hookGeneration ?? generation),
            actionId: `${owner}/${id}`,
            family: entry.family ?? "capability",
            schemaDigest: canonicalDigest(registration),
            effectDigest: canonicalDigest(declaration.authority.effects),
            authorityDigest: canonicalDigest({ authority: declaration.authority, activation }),
            resultDigest: canonicalDigest({ decisions: "hook-v1" }),
            settlementDigest: canonicalDigest({ point: registration.point }),
            catalogGeneration: entry.source.activation.catalogGeneration,
          },
        };
      } catch (error) {
        return {
          status: "unavailable",
          reason: error instanceof ExtensionInputError ? error.code : "hook-contract-unavailable",
        };
      }
    },
  };
}
