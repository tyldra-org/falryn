/**
 * Product composer submission port (#707 / #715 / #717).
 *
 * Maps a composer snapshot onto the application-owned live-turn executor.
 * Accepted means the provider turn reached a durable terminal result; a
 * producer-only turn is never reported as accepted.
 */

import {
  composeProductBriefControls,
  composeProductOutputControls,
  type ProductBriefControls,
  type ProductOutputControls,
} from "../../application/compression/index.ts";
import type {
  ProductExecutionProfileControls,
  ProductLiveTurnExecutor,
  ProductModelSelectionControls,
} from "../../application/runtime/index.ts";
import {
  type CapabilityMentionAdmission,
  capabilityMentionSection,
  describeCapabilityMentionFailures,
} from "../../domain/context/capability-mentions.ts";
import type { ComposerToken } from "../../domain/context/composer-mentions.ts";
import {
  type ConfigurationGeneration,
  type SessionId,
  type TurnId,
  turnId,
} from "../../domain/foundation/index.ts";
import type { ComposerSnapshot, SubmissionOutcome, SubmissionPort } from "./submission.ts";

export const PRODUCT_SUBMISSION_OWNER = "#707";

export type ProductSubmissionPortOptions = {
  readonly executor: ProductLiveTurnExecutor;
  readonly sessionId: SessionId;
  readonly configurationGeneration: ConfigurationGeneration;
  /** Stable turn ids for tests; defaults to a monotonic counter. */
  readonly nextTurnId?: () => TurnId;
  /**
   * When false, submission fails closed even if a producer exists (for example
   * the process is shutting down). Defaults to true.
   */
  readonly isAccepting?: () => boolean;
  /** Shared Brief controls for TUI/session (#717). */
  readonly brief?: ProductBriefControls;
  /** Shared Hush/Loom controls for this TUI session. */
  readonly output?: ProductOutputControls;
  /**
   * Resolves a skill command in the submitted text (#1179). The composer's own text is
   * admitted user input, so a match is sent with user origin.
   */
  readonly resolveSkill?: (
    text: string,
  ) => import("../../domain/context/skill-invocation.ts").SkillCommand | null;
  /**
   * Admits the snapshot's `$` mention tokens against the current catalog (#1206). The
   * host connects a picked MCP server whose catalog is not current before answering.
   */
  readonly admitMentions?: (
    tokens: readonly ComposerToken[],
    signal: AbortSignal,
  ) => Promise<CapabilityMentionAdmission>;
};

export type ProductSubmissionPort = SubmissionPort & {
  readonly processing?: import("../../application/providers/processing-controls.ts").ProcessingSessionControl;
  readonly generation?: import("../../application/providers/generation-timing.ts").GenerationActivity;
  readonly modelSettings?:
    | import("../../application/providers/model-settings.ts").ModelSettingsService
    | undefined;
  readonly brief: ProductBriefControls;
  readonly output: ProductOutputControls;
  readonly executionProfile: ProductExecutionProfileControls;
  readonly modelSelection: ProductModelSelectionControls;
};

/**
 * Build a submission port that executes a complete durable model turn.
 */
export function createProductSubmissionPort(
  options: ProductSubmissionPortOptions,
): ProductSubmissionPort {
  const nextTurnId =
    options.nextTurnId ??
    (() => {
      return turnId.from(`turn-submit:${crypto.randomUUID()}`);
    });
  const brief = options.brief ?? composeProductBriefControls();
  const output = options.output ?? composeProductOutputControls();
  const executionProfile = options.executor.executionProfile ?? {
    get: () => "agent" as const,
    async select() {
      return {
        ok: false as const,
        code: "execution-profile.unavailable",
        message: "execution profile controls are not attached",
      };
    },
  };

  return {
    processing: options.executor.processing,
    generation: options.executor.generation,
    brief,
    output,
    executionProfile,
    modelSelection: options.executor.modelSelection,
    async submit(snapshot, context): Promise<SubmissionOutcome> {
      if (snapshot.text.trim() === "" && snapshot.attachments.length === 0) {
        return unavailable(snapshot, "the composer is empty");
      }
      if (options.isAccepting !== undefined && !options.isAccepting()) {
        return unavailable(snapshot, "the agent is not accepting submissions right now");
      }

      const id = nextTurnId();
      const skill = options.resolveSkill?.(snapshot.text) ?? null;
      if (skill?.kind === "ambiguous")
        return unavailable(
          snapshot,
          `a skill and a prompt template are both named ${skill.name}; use /skill:${skill.name} or the template's /<package>:${skill.name}`,
        );
      const capabilityTokens = snapshot.tokens.filter((token) => token.trigger === "$");
      let mentions: Extract<CapabilityMentionAdmission, { ok: true }> | null = null;
      if (capabilityTokens.length > 0) {
        if (options.admitMentions === undefined) {
          return mentionRefusal(snapshot, "capability mentions are unavailable in this session");
        }
        const admitted = await options.admitMentions(
          capabilityTokens,
          context?.signal ?? new AbortController().signal,
        );
        if (!admitted.ok) {
          return mentionRefusal(
            snapshot,
            `nothing was sent: ${describeCapabilityMentionFailures(admitted.failures)}`,
          );
        }
        mentions = admitted;
      }
      const userSkills = [
        ...(skill?.kind === "skill" ? [skill.name] : []),
        ...(mentions?.skills ?? []),
      ];
      const section = mentions === null ? null : capabilityMentionSection(mentions);
      const briefRequest = brief.requestForTurn({
        turnId: id,
        sessionId: options.sessionId,
        configurationGeneration: options.configurationGeneration,
        prompt: snapshot.text,
        interface: "interactive",
      });
      const started = await options.executor.run({
        prompt: snapshot.text,
        ...(userSkills.length === 0 ? {} : { userSkills: [...new Set(userSkills)] }),
        ...(snapshot.tokens.length === 0
          ? {}
          : {
              mentions: {
                tokens: snapshot.tokens.map(({ id: _id, ...token }) => token),
                preferredCapabilityIds: mentions?.preferredCapabilityIds ?? [],
                mcpServers: mentions?.mcpServers ?? [],
              },
            }),
        ...(section === null
          ? {}
          : {
              otherSections: [
                {
                  id: "capability-mentions",
                  role: "task" as const,
                  source: "composer-mentions",
                  content: section,
                  required: true,
                  available: true,
                },
              ],
            }),
        attachmentSelection: {
          attachments: snapshot.attachments,
          mentions: snapshot.mentions,
          ...(context === undefined ? {} : { payloads: context.payloads }),
        },
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
        turnId: id,
        ...(briefRequest === null ? {} : { briefRequest }),
      });
      if (started.kind !== "completed") {
        return unavailable(snapshot, `${started.message} (${started.code})`);
      }

      return { kind: "accepted", snapshot };
    },
  };
}

function unavailable(snapshot: ComposerSnapshot, reason: string): SubmissionOutcome {
  return {
    kind: "unavailable",
    snapshot,
    reason: `${reason} (${PRODUCT_SUBMISSION_OWNER})`,
    owner: PRODUCT_SUBMISSION_OWNER,
    route: "app.commandPalette",
  };
}

/** A refused mention names its token and repair; the draft and its tokens stay (#1206). */
function mentionRefusal(snapshot: ComposerSnapshot, reason: string): SubmissionOutcome {
  return {
    kind: "unavailable",
    snapshot,
    reason,
    owner: "#1206",
    route: "composer.suggestions.reopen",
  };
}
