/**
 * Admitted package prompt templates as explicit slash actions (#1168).
 *
 * Registration binds preparation metadata only. The body is read from the
 * admitted package bytes at invocation, after the host rechecks admission, and
 * rendered once by the domain template codec. Expansion produces text; it never
 * submits a turn, runs package code or dispatches hooks.
 */
import {
  expandPromptTemplate,
  isPromptAlias,
  type PromptTemplateErrorCode,
  parsePromptInvocation,
  parsePromptTemplateSource,
} from "../../domain/context/prompt-templates.ts";
import {
  bytesDigest,
  canonicalDigest,
  ExtensionInputError,
} from "../../domain/extensions/canonical.ts";
import type { NativeRegistrationOwner } from "./native-registration.ts";

export const PACKAGE_PROMPT_OWNER = "falryn-prompt-templates-v1";

/** Exact admitted source for one bound template; the host rechecks admission first. */
export type PromptTemplateReadRequest = {
  readonly packageId: string;
  readonly expectedRevision: number;
  readonly contribution: string;
  readonly activation: string;
  readonly path: string;
};
/** Throws an ExtensionInputError whose code names why the source is unavailable. */
export type PromptTemplateRead = (
  request: PromptTemplateReadRequest,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export type RegisteredPromptTemplate = {
  readonly actionId: string;
  readonly packageId: string;
  readonly packageDigest: string;
  readonly localId: string;
  /** Package-qualified slash name, always unique per package. */
  readonly qualifiedName: string;
  readonly description: string;
  readonly argumentHint: string | null;
  readonly source: PromptTemplateReadRequest;
  /** Read the exact admitted source; the host rechecks current admission first. */
  read(signal: AbortSignal): Promise<Uint8Array>;
};

/** Body-free provenance for one expansion; the input to user.prompt.expand (#1077). */
export type PromptExpansionFact = {
  readonly version: 1;
  readonly actionId: string;
  readonly packageId: string;
  readonly packageDigest: string;
  readonly contribution: string;
  readonly prompt: string;
  readonly contentDigest: string;
  readonly argumentCount: number;
  readonly substitutions: number;
  readonly renderedBytes: number;
};

export type PromptExpansionFailureCode =
  | PromptTemplateErrorCode
  | "unknown-template"
  | "ambiguous-template"
  | "template-unavailable"
  | "cancelled";

export type PromptExpansion =
  | { readonly kind: "not-template" }
  | {
      readonly kind: "expanded";
      readonly name: string;
      readonly text: string;
      readonly fact: PromptExpansionFact;
    }
  | {
      readonly kind: "failed";
      readonly name: string;
      readonly code: PromptExpansionFailureCode;
      /** Owner reason for an unavailable source, such as stale-native-catalog. */
      readonly reason?: string;
      readonly message: string;
    };

export type PromptTemplateCatalog = {
  readonly templates: readonly RegisteredPromptTemplate[];
  /** Expand slash text naming a template; other text is not-template. */
  expand(text: string, signal: AbortSignal): Promise<PromptExpansion>;
};

export function createNativePromptOwner(options: {
  read: PromptTemplateRead;
}): NativeRegistrationOwner {
  return {
    id: PACKAGE_PROMPT_OWNER,
    kind: "prompt",
    register({ entry, contribution, activation, generation }) {
      if (entry.source.kind !== "package")
        throw new ExtensionInputError("native-prompt-package-required");
      const declaration = contribution.declaration;
      if (
        contribution.mode !== "declarative" ||
        contribution.path === null ||
        declaration.execution !== undefined
      )
        return { status: "unavailable", reason: "prompt-declaration-invalid" };
      const localId = contribution.identity.localId;
      if (!isPromptAlias(localId)) return { status: "unavailable", reason: "prompt-alias-invalid" };
      const frontmatter = declaration.frontmatter;
      const hint =
        typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter)
          ? (frontmatter as Record<string, unknown>)["argument-hint"]
          : undefined;
      const identity = canonicalDigest({
        contribution: contribution.identityDigest,
        scope: canonicalDigest(activation.scopeKey),
      }).slice(7);
      const actionId = "plugin:prompt/" + identity + "@1";
      const packageId = entry.source.owner.packageId;
      const source: PromptTemplateReadRequest = {
        packageId,
        expectedRevision: activation.installedRevision,
        contribution: contribution.identityDigest,
        activation: canonicalDigest(activation),
        path: contribution.path,
      };
      return {
        status: "registered",
        binding: {
          version: 1,
          contributionIdentityDigest: contribution.identityDigest,
          extensionActivationDigest: canonicalDigest(entry.source.activation),
          nativeRegistryOwner: PACKAGE_PROMPT_OWNER,
          nativeRegistryGeneration: Number(generation),
          actionId,
          family: "capability",
          schemaDigest: canonicalDigest({ version: 1, input: "prompt-template-arguments" }),
          effectDigest: canonicalDigest([]),
          authorityDigest: canonicalDigest({ activation, authority: contribution.authority }),
          resultDigest: canonicalDigest({ kind: "prompt-expansion", version: 1 }),
          settlementDigest: canonicalDigest({ version: 1, owner: "draft-text-only" }),
          catalogGeneration: entry.source.activation.catalogGeneration,
        },
        prompt: {
          actionId,
          packageId,
          packageDigest: entry.contribution.owner.digest,
          localId,
          qualifiedName: packageId + ":" + localId,
          description: typeof declaration.description === "string" ? declaration.description : "",
          argumentHint: typeof hint === "string" && hint !== "" ? hint : null,
          source,
          read: (signal) => options.read(source, signal),
        },
      };
    },
  };
}

/** Resolve and expand against one publication's bound templates. */
export function createPromptTemplateCatalog(
  templates: readonly RegisteredPromptTemplate[],
): PromptTemplateCatalog {
  return {
    templates,
    async expand(text, signal) {
      const invocation = parsePromptInvocation(text);
      if (invocation === null) return { kind: "not-template" };
      const name = invocation.name;
      const qualified = name.includes(":");
      const matches = templates.filter((template) =>
        qualified ? template.qualifiedName === name : template.localId === name,
      );
      const failed = (
        code: PromptExpansionFailureCode,
        message: string,
        reason?: string,
      ): PromptExpansion => ({
        kind: "failed",
        name,
        code,
        message,
        ...(reason === undefined ? {} : { reason }),
      });
      const [template] = matches;
      if (template === undefined)
        return failed("unknown-template", "no admitted prompt template is named /" + name);
      if (matches.length > 1)
        return failed(
          "ambiguous-template",
          "/" +
            name +
            " is provided by more than one package or scope; use " +
            [...new Set(matches.map((match) => "/" + match.qualifiedName))].sort().join(" or "),
        );
      let bytes: Uint8Array;
      try {
        bytes = await template.read(signal);
      } catch (error) {
        if (signal.aborted) return failed("cancelled", "expansion of /" + name + " was cancelled");
        const reason =
          error instanceof ExtensionInputError ? error.code : "prompt-source-unavailable";
        return failed(
          "template-unavailable",
          "/" + name + " is no longer admitted (" + reason + ")",
          reason,
        );
      }
      if (signal.aborted) return failed("cancelled", "expansion of /" + name + " was cancelled");
      const source = parsePromptTemplateSource(bytes);
      const rendered = source.ok
        ? expandPromptTemplate(source.value, invocation.argumentText)
        : source;
      if (!rendered.ok)
        return failed(rendered.error.code, "/" + name + ": " + rendered.error.message);
      return {
        kind: "expanded",
        name,
        text: rendered.value.text,
        fact: {
          version: 1,
          actionId: template.actionId,
          packageId: template.packageId,
          packageDigest: template.packageDigest,
          contribution: template.source.contribution,
          prompt: template.qualifiedName,
          contentDigest: bytesDigest(bytes),
          argumentCount: rendered.value.argumentCount,
          substitutions: rendered.value.substitutions,
          renderedBytes: rendered.value.renderedBytes,
        },
      };
    },
  };
}
