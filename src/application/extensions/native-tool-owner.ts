import {
  canonicalDigest,
  canonicalJson,
  ExtensionInputError,
} from "../../domain/extensions/canonical.ts";
import type { CapabilityBindingV1 } from "../../domain/extensions/identity.ts";
import {
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import type { NativeRegistrationOwner } from "./native-registration.ts";
import { packageToolContract } from "./package-tool-contract.ts";
import type { createPackageToolExecution } from "./package-tool-execution.ts";

export const PACKAGE_TOOL_OWNER = "falryn-tool-registry-v1";
export function createNativeToolOwner(options: {
  execute: ReturnType<typeof createPackageToolExecution>;
  qualified(): boolean;
}): NativeRegistrationOwner {
  return {
    id: PACKAGE_TOOL_OWNER,
    kind: "tool",
    register({ entry, contribution, activation, generation }) {
      if (!options.qualified())
        return { status: "unavailable", reason: "native-tool-host-unavailable" };
      if (entry.source.kind !== "package")
        throw new ExtensionInputError("native-tool-package-required");
      try {
        const contract = packageToolContract(contribution);
        const identity = canonicalDigest({
          contribution: contribution.identityDigest,
          scope: activation.scopeKey,
        }).slice(7);
        const name = `pkg_${BigInt(`0x${identity}`).toString(36).padStart(50, "0")}`;
        const built = createToolRegistryEntry(
          {
            namespace: "package",
            name,
            version: 1,
            source: "plugin",
            title: Array.from(`${entry.source.owner.packageId}/${contribution.identity.localId}`)
              .slice(0, 64)
              .join(""),
            description: Array.from(
              `${entry.source.owner.packageId}: ${contract.declaration.description}`,
            )
              .slice(0, 256)
              .join(""),
            effect: "observation",
            capabilityKind: "plugin",
            platforms: [{ os: ["darwin"], arch: ["arm64"] }],
            limits: defaultToolLimits({
              maxInputBytes: 8_192,
              maxOutputBytes: 16_384,
              defaultTimeoutMs: 30_000,
            }),
            concurrency: defaultConcurrencyContract({ maxGlobal: 4, maxPerWorkspace: 1 }),
            resultProjection: defaultProjectionContract({ modelMaxBytes: 8_192 }),
          },
          { inputSchema: contract.input, outputSchema: contract.output },
        );
        if (!built.ok) throw new ExtensionInputError(`native-tool-${built.error.code}`);
        const tool = built.value;
        const binding: CapabilityBindingV1 = {
          version: 1,
          contributionIdentityDigest: contribution.identityDigest,
          extensionActivationDigest: canonicalDigest(entry.source.activation),
          nativeRegistryOwner: PACKAGE_TOOL_OWNER,
          nativeRegistryGeneration: Number(generation),
          actionId: tool.manifest.capabilityId,
          family: contract.family,
          schemaDigest: contract.inputDigest,
          effectDigest: canonicalDigest(contract.declaration.authority.effects),
          authorityDigest: canonicalDigest({
            authority: contract.declaration.authority,
            activation,
          }),
          resultDigest: contract.outputDigest,
          settlementDigest: canonicalDigest({
            version: 1,
            effect: "observation",
            protocol: "one-terminal-result",
          }),
          catalogGeneration: entry.source.activation.catalogGeneration,
        };
        const packageId = entry.source.owner.packageId;
        const validateOutput = (value: unknown) => {
          try {
            return (
              Buffer.byteLength(canonicalJson(value)) <= 16_384 &&
              contract.output.safeParse(value).success
            );
          } catch {
            return false;
          }
        };
        return {
          status: "registered",
          binding,
          tool: {
            entry: tool,
            runner: {
              hasBinding: (id) => id === tool.manifest.capabilityId,
              async execute(request: ToolRunnerRequest) {
                if (
                  request.capabilityId !== tool.manifest.capabilityId ||
                  request.toolName !== name ||
                  request.version !== 1 ||
                  request.effect !== "observation" ||
                  !contract.input.safeParse(request.input).success
                )
                  return {
                    status: "failed",
                    reason: "native-tool-binding-mismatch",
                    effect: "none",
                  };
                return options.execute({
                  packageId,
                  expectedRevision: activation.installedRevision,
                  contribution: contribution.identityDigest,
                  activation: canonicalDigest(activation),
                  request,
                  validateOutput,
                });
              },
            },
          },
        };
      } catch (error) {
        return {
          status: "unavailable",
          reason:
            error instanceof ExtensionInputError ? error.code : "native-tool-schema-unavailable",
        };
      }
    },
  };
}
