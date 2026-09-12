/** A frozen execution ceiling. It narrows native policy and never grants an effect. */
import { z } from "zod";
import { EFFECT_CLASSES } from "./work.ts";

const identity = z.string().min(1).max(1024);
export const childProviderBindingSchema = z
  .object({
    providerId: identity,
    providerProfileId: identity,
    providerDestinationId: identity,
    modelId: identity,
    reasoning: identity,
    reasoningControl: identity.nullable(),
  })
  .strict();
export type ChildProviderBinding = z.infer<typeof childProviderBindingSchema>;
export const childAuthoritySchema = z
  .object({
    version: z.literal(1),
    workspaceId: identity,
    configurationGeneration: identity,
    capabilityGeneration: identity,
    providers: z.array(childProviderBindingSchema),
    capabilities: z.array(identity),
    effects: z.array(z.enum(EFFECT_CLASSES)),
  })
  .strict();
export type ChildAuthority = Readonly<z.infer<typeof childAuthoritySchema>>;
export type ChildWorkTarget =
  | {
      readonly kind: "session-history";
      readonly workspaceId: string;
      readonly configurationGeneration: string;
    }
  | {
      readonly kind: "provider";
      readonly workspaceId: string;
      readonly binding: ChildProviderBinding;
    }
  | {
      readonly kind: "tool";
      readonly workspaceId: string;
      readonly capabilityId: string;
      readonly capabilityGeneration: string;
    };

export function sameChildProvider(
  left: ChildProviderBinding,
  right: ChildProviderBinding,
): boolean {
  return (
    left.providerId === right.providerId &&
    left.providerProfileId === right.providerProfileId &&
    left.providerDestinationId === right.providerDestinationId &&
    left.modelId === right.modelId &&
    left.reasoning === right.reasoning &&
    left.reasoningControl === right.reasoningControl
  );
}

/** Reject a generation/workspace change; intersect all selectable authority. */
export function narrowChildAuthority(
  parent: ChildAuthority,
  requested: ChildAuthority,
): ChildAuthority | null {
  if (
    parent.workspaceId !== requested.workspaceId ||
    parent.configurationGeneration !== requested.configurationGeneration ||
    parent.capabilityGeneration !== requested.capabilityGeneration
  )
    return null;
  return {
    ...requested,
    providers: requested.providers.filter((value) =>
      parent.providers.some((allowed) => sameChildProvider(value, allowed)),
    ),
    capabilities: requested.capabilities.filter((value) => parent.capabilities.includes(value)),
    effects: requested.effects.filter((value) => parent.effects.includes(value)),
  };
}
