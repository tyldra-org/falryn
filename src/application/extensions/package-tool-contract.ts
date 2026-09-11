import { z } from "zod";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { contributionDeclarationSchema } from "../../domain/extensions/manifest.ts";
import { PACKAGE_TOOL_PROTOCOL } from "../../domain/extensions/package-health.ts";
import { definitionValueSchema } from "../../domain/orchestration/definition-values.ts";
import type { PreparedContribution } from "./prepare-package.ts";

/** This first native adapter admits bounded, observation-only, offline scalar tools. */
export function packageToolContract(contribution: PreparedContribution) {
  const declaration = contributionDeclarationSchema.parse(contribution.declaration);
  if (
    declaration.kind !== "tool" ||
    contribution.mode !== "governed" ||
    !declaration.execution ||
    declaration.execution.loader !== "native" ||
    declaration.execution.protocolVersion !== PACKAGE_TOOL_PROTOCOL
  )
    throw new ExtensionInputError("native-tool-protocol-unavailable");
  if (
    !declaration.family ||
    declaration.authority.effects.length !== 1 ||
    declaration.authority.effects[0] !== "observation" ||
    declaration.authority.permissions.length ||
    declaration.authority.roots.length ||
    declaration.authority.destinations.length ||
    declaration.authority.secretReferences.length ||
    declaration.authority.localData.length ||
    declaration.execution.expectedChildren.length ||
    declaration.execution.hostIntegrations.length ||
    declaration.configuration.length ||
    declaration.state.length ||
    declaration.batching?.nativeBatch ||
    declaration.batching?.background
  )
    throw new ExtensionInputError("native-tool-authority-unavailable");
  const input = definitionValueSchema.parse(declaration.inputSchema);
  const output = definitionValueSchema.parse(declaration.outputSchema);
  if (input.type !== "object" || output.type !== "object")
    throw new ExtensionInputError("native-tool-object-schema-required");
  const inputCodec = z.fromJSONSchema(input);
  const outputCodec = z.fromJSONSchema(output);
  if (!(inputCodec instanceof z.ZodObject) || !(outputCodec instanceof z.ZodObject))
    throw new ExtensionInputError("native-tool-object-schema-required");
  return {
    declaration,
    family: declaration.family,
    input: inputCodec,
    output: outputCodec,
    inputDigest: canonicalDigest(input),
    outputDigest: canonicalDigest(output),
  };
}
