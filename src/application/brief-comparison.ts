/** Pinned Caveman research adapter for the Brief scorecard (#827). */

import { createHash } from "node:crypto";

import { err, ok, type PromptSectionInput, type Result } from "../domain/index.ts";

export const CAVEMAN_PINNED_COMMIT = "17f9f2ec2377b0bfe16b52ee03a462e7f0a02bc8";
export const CAVEMAN_PINNED_SKILL_PATH = "skills/caveman/SKILL.md";
export const CAVEMAN_PINNED_SKILL_DIGEST =
  "3edd677596cbf12f010f25f05dfb1e8a6c9c178d92499c86e5b5afa44c86c16c";
export const CAVEMAN_ADAPTER_VERSION = "falryn.caveman.v2";
export const CAVEMAN_INTENSITIES = ["lite", "full", "ultra"] as const;
export type CavemanIntensity = (typeof CAVEMAN_INTENSITIES)[number];

export type CavemanSourcePort = {
  read(input: {
    readonly commit: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }): Promise<
    Result<
      { readonly commit: string; readonly content: string },
      { readonly code: "cancelled" | "unavailable"; readonly detail: string }
    >
  >;
};

export type PinnedCavemanPolicy = {
  readonly commit: typeof CAVEMAN_PINNED_COMMIT;
  readonly intensity: CavemanIntensity;
  readonly sourceDigest: typeof CAVEMAN_PINNED_SKILL_DIGEST;
  readonly policyDigest: string;
  readonly adapterVersion: typeof CAVEMAN_ADAPTER_VERSION;
  readonly section: PromptSectionInput;
};

export type CavemanPolicyError = {
  readonly code: "cancelled" | "unavailable" | "baseline-drift" | "unsupported-intensity";
  readonly detail: string;
};

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function intensityDirective(intensity: CavemanIntensity): string {
  switch (intensity) {
    case "lite":
      return "Selected intensity: lite. Remove filler and hedging; retain articles and complete sentences.";
    case "full":
      return "Selected intensity: full. Apply the pinned full rules exactly.";
    case "ultra":
      return "Selected intensity: ultra. Apply the pinned ultra rules exactly without altering technical text.";
  }
}

/** Load exact pinned instructions. Any commit or byte drift invalidates the row. */
export async function loadPinnedCavemanPolicy(
  source: CavemanSourcePort,
  intensity: CavemanIntensity | string,
  signal?: AbortSignal,
): Promise<Result<PinnedCavemanPolicy, CavemanPolicyError>> {
  if (!(CAVEMAN_INTENSITIES as readonly string[]).includes(intensity)) {
    return err({ code: "unsupported-intensity", detail: String(intensity) });
  }
  if (signal?.aborted === true) {
    return err({ code: "cancelled", detail: "baseline load cancelled" });
  }
  const loaded = await source.read({
    commit: CAVEMAN_PINNED_COMMIT,
    path: CAVEMAN_PINNED_SKILL_PATH,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!loaded.ok) {
    return loaded.error.code === "cancelled"
      ? err({ code: "cancelled", detail: loaded.error.detail })
      : err({ code: "unavailable", detail: loaded.error.detail });
  }
  const sourceDigest = digest(loaded.value.content);
  if (
    loaded.value.commit !== CAVEMAN_PINNED_COMMIT ||
    sourceDigest !== CAVEMAN_PINNED_SKILL_DIGEST
  ) {
    return err({
      code: "baseline-drift",
      detail: `expected ${CAVEMAN_PINNED_COMMIT}:${CAVEMAN_PINNED_SKILL_DIGEST}`,
    });
  }
  const selected = intensity as CavemanIntensity;
  const content = `${loaded.value.content.trim()}\n\n${intensityDirective(selected)}`;
  return ok({
    commit: CAVEMAN_PINNED_COMMIT,
    intensity: selected,
    sourceDigest: CAVEMAN_PINNED_SKILL_DIGEST,
    policyDigest: digest(`${CAVEMAN_ADAPTER_VERSION}\0${selected}\0${content}`),
    adapterVersion: CAVEMAN_ADAPTER_VERSION,
    section: {
      id: "brief",
      role: "brief",
      source: `caveman:${CAVEMAN_PINNED_COMMIT}:${selected}`,
      required: true,
      available: true,
      content,
    },
  });
}
