/** Package declarations bind inert native definitions; package code never owns timers. */
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type ScheduleStore,
  scheduleDefinitionSchema,
} from "../../domain/orchestration/schedule-state.ts";
import type { NativeRegistrationOwner } from "./native-registration.ts";
export const PACKAGE_SCHEDULE_OWNER = "falryn-schedule-registry-v1";
export function createNativeScheduleOwner(
  options:
    | {
        store: ScheduleStore;
        workspace: string;
        now(): number;
      }
    | undefined,
): NativeRegistrationOwner {
  return {
    id: PACKAGE_SCHEDULE_OWNER,
    kind: "schedule",
    register({ entry, contribution, activation, generation }) {
      if (entry.source.kind !== "package")
        return { status: "unavailable", reason: "schedule-package-required" };
      const definition = scheduleDefinitionSchema.safeParse(contribution.declaration.schedule);
      if (!definition.success || contribution.mode !== "declarative")
        return { status: "unavailable", reason: "schedule-declaration-invalid" };
      const scope = canonicalDigest(activation.scopeKey);
      const identity = canonicalDigest({ contribution: contribution.identityDigest, scope }).slice(
        7,
      );
      const actionId = `plugin:schedule/${identity}@1`;
      if (options) {
        const now = options.now();
        const saved = options.store.create({
          version: 1,
          id: `package-${identity}`,
          workspace: options.workspace,
          generation: 1,
          revision: 1,
          definition: definition.data,
          digest: canonicalDigest(definition.data),
          source: {
            kind: "package",
            contribution: actionId,
            digest: entry.contribution.owner.digest,
            scope,
            effects: contribution.authority.effects,
          },
          state: "disabled",
          binding: null,
          createdAt: now,
          anchor: now,
          cursor: now - 1,
          updatedAt: now,
          blocker: null,
          recovery: null,
        });
        if (!saved.ok) return { status: "unavailable", reason: `schedule-${saved.error.code}` };
      }
      return {
        status: "registered",
        binding: {
          version: 1,
          contributionIdentityDigest: contribution.identityDigest,
          extensionActivationDigest: canonicalDigest(entry.source.activation),
          nativeRegistryOwner: PACKAGE_SCHEDULE_OWNER,
          nativeRegistryGeneration: Number(generation),
          actionId,
          family: "capability",
          schemaDigest: canonicalDigest({ version: 1, trigger: "native-data-only" }),
          effectDigest: canonicalDigest(contribution.authority.effects),
          authorityDigest: canonicalDigest({ activation, authority: contribution.authority }),
          resultDigest: canonicalDigest({ kind: "schedule", version: 1 }),
          settlementDigest: canonicalDigest({ version: 1, owner: "durable-occurrence" }),
          catalogGeneration: entry.source.activation.catalogGeneration,
        },
      };
    },
  };
}
