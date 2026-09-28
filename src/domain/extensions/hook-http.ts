/**
 * Package HTTP hook handlers (#1175): the declaration a package may ship and the grant
 * a user gives when enabling it. The package names an exact HTTPS endpoint and, at most,
 * one credential by name; only the user's activation approves that endpoint and maps the
 * name to one of the user's own credential references. Nothing here makes a request.
 */
import { z } from "zod";
import type { CredentialReference } from "../configuration/configuration.ts";
import {
  MAX_CREDENTIAL_LABEL_LENGTH,
  MAX_CREDENTIAL_LOCATOR_LENGTH,
} from "../security/credential.ts";
import { ExtensionInputError } from "./canonical.ts";
import type { HookRegistration } from "./hook-handlers.ts";
import { isRemoteHookDeclaration } from "./hook-remote.ts";
import { digestSchema } from "./identity.ts";
import type { ContributionDeclaration } from "./manifest.ts";

export type HttpHookRegistration = HookRegistration & {
  readonly handler: Extract<HookRegistration["handler"], { kind: "http-v1" }>;
};

/** The user's approval for one HTTP hook contribution, stored with its activation. */
export const httpHookGrantSchema = z.strictObject({
  contribution: digestSchema,
  /** Exactly the declared endpoint; approving it is the only way it can be reached. */
  url: z.string().min(1).max(2_048),
  /** The user's credential for the handler's named credential, when it names one. */
  credential: z
    .strictObject({
      storeKind: z.enum(["operating-system-keychain", "environment"]),
      locator: z.string().min(1).max(MAX_CREDENTIAL_LOCATOR_LENGTH),
      accountLabel: z.string().min(1).max(MAX_CREDENTIAL_LABEL_LENGTH).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type HttpHookGrant = z.infer<typeof httpHookGrantSchema>;

/** What enabling one HTTP hook contribution requires the user to approve. */
export type HttpHookGrantRequirement = {
  readonly contribution: string;
  readonly url: string;
  /** The handler's credential name, or null when it sends none. */
  readonly credential: string | null;
};

/**
 * An HTTP hook starts no package code and may name, at most, its own credential.
 */
export function httpHookContract(declaration: ContributionDeclaration): HttpHookRegistration {
  const registration = declaration.hook;
  const handler = registration?.handler;
  const credential = handler?.kind === "http-v1" ? (handler.credentialReference ?? null) : null;
  if (
    registration === undefined ||
    handler?.kind !== "http-v1" ||
    !isRemoteHookDeclaration(declaration, credential === null ? [] : [credential])
  )
    throw new ExtensionInputError("hook-http-declaration-invalid");
  return { ...registration, handler };
}

export function httpHookGrantRequirement(
  contribution: string,
  registration: HttpHookRegistration,
): HttpHookGrantRequirement {
  return {
    contribution,
    url: registration.handler.url,
    credential: registration.handler.credentialReference ?? null,
  };
}

/**
 * Why a grant does not approve its requirement, or null when it does exactly. A grant of
 * another kind (null) approves no destination.
 */
export function httpHookGrantProblem(
  requirement: HttpHookGrantRequirement,
  grant: HttpHookGrant | null | undefined,
): string | null {
  if (grant === undefined) return "hook-grant-required";
  if (grant === null || grant.url !== requirement.url) return "hook-grant-destination-mismatch";
  if ((requirement.credential === null) !== (grant.credential === null))
    return "hook-grant-credential-mismatch";
  return null;
}

/**
 * The reference a granted credential resolves as. Its consumer is the contribution, so
 * the shared resolver refuses it to any other hook, server or integration.
 */
export function hookCredentialReference(grant: HttpHookGrant): CredentialReference | null {
  return grant.credential === null
    ? null
    : { ...grant.credential, consumer: "hook:" + grant.contribution };
}
