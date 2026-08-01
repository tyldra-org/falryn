/**
 * This area's claim on the configuration ownership class.
 *
 * Registered here rather than in the local-data registry because the rule is
 * that an owner registers its own class: a registry populated by its owners
 * cannot drift from what actually exists, and one hand-maintained elsewhere
 * drifts the first time an owner changes shape.
 *
 * Configuration is user-authored, so removing it is never implied by anything
 * else. Reset preserves it unless it was explicitly selected.
 */

import type { OwnershipRegistration } from "../domain/index.ts";

export const CONFIGURATION_OWNERSHIP: OwnershipRegistration = {
  ownershipClass: "configuration",
  owner: "config",
  durability: "user-authored",
  removalPosture: "preserve-unless-selected",
  roots: ["configuration"],
  external: false,
};
