import { AVAILABLE, type ShellCommand, unavailable } from "./contracts.ts";

function composerWorkAvailability(
  state: Parameters<ShellCommand["availability"]>[0],
  activeReason: string,
): ReturnType<ShellCommand["availability"]> {
  if (!state.hasComposer) {
    return unavailable("the composer is not focused");
  }
  return state.hasRunningWork ? AVAILABLE : unavailable(activeReason);
}

/** Composer and confirmation commands. */
export const COMPOSER_COMMANDS: readonly ShellCommand[] = [
  {
    id: "composer.submit",
    title: "Submit",
    description:
      "Send what is in the composer. While a turn is active, this queues a follow-up by default.",
    context: "composer",
    defaultBinding: "return",
    keywords: ["send", "run", "ask", "follow-up"],
    availability: (state) =>
      state.hasComposer ? AVAILABLE : unavailable("the composer is not focused"),
  },
  {
    id: "composer.submitAsSteer",
    title: "Submit as steer",
    description: "Attach this draft to the in-flight attempt without starting a second turn.",
    context: "composer",
    defaultBinding: null,
    keywords: ["steer", "correct", "mid-turn"],
    availability: (state) => composerWorkAvailability(state, "no turn is in flight to steer"),
  },
  {
    id: "composer.submitAsFollowUp",
    title: "Submit as follow-up",
    description: "Queue this draft as the next turn after the current one finishes.",
    context: "composer",
    defaultBinding: null,
    keywords: ["follow-up", "queue", "mid-turn"],
    availability: (state) =>
      composerWorkAvailability(state, "no turn is in flight to queue against"),
  },
  {
    id: "composer.newline",
    title: "Insert a newline",
    description: "Add a line without submitting.",
    context: "composer",
    defaultBinding: "shift+return",
    keywords: ["newline", "multiline"],
    availability: (state) =>
      state.hasComposer ? AVAILABLE : unavailable("the composer is not focused"),
  },
  {
    id: "composer.historyPrevious",
    title: "Previous entry",
    description: "Recall the previous submission.",
    context: "composer",
    defaultBinding: null,
    keywords: ["history", "previous", "recall"],
    availability: (state) =>
      state.hasComposer ? AVAILABLE : unavailable("the composer is not focused"),
  },
  {
    id: "composer.historyNext",
    title: "Next entry",
    description: "Move forward through recalled submissions.",
    context: "composer",
    defaultBinding: null,
    keywords: ["history", "next"],
    availability: (state) =>
      state.hasComposer ? AVAILABLE : unavailable("the composer is not focused"),
  },
  {
    id: "composer.includePaste",
    title: "Include the held paste",
    description: "Attach the last large paste without inserting it into the draft.",
    context: "composer",
    defaultBinding: null,
    keywords: ["include", "paste", "attach"],
    availability: (state) =>
      state.hasHeldPaste ? AVAILABLE : unavailable("there is no held-out paste to include"),
  },
  {
    id: "composer.excludePaste",
    title: "Discard the held paste",
    description: "Drop the last large paste without attaching it.",
    context: "composer",
    defaultBinding: null,
    keywords: ["exclude", "paste", "discard"],
    availability: (state) =>
      state.hasHeldPaste ? AVAILABLE : unavailable("there is no held-out paste to discard"),
  },
  {
    id: "composer.removeAttachment",
    title: "Remove the last attachment",
    description: "Detach the last attached paste or file.",
    context: "composer",
    defaultBinding: null,
    keywords: ["attachment", "remove", "detach"],
    availability: (state) =>
      state.hasAttachments ? AVAILABLE : unavailable("there is no attachment to remove"),
  },
  {
    id: "composer.moveAttachmentEarlier",
    title: "Move attachment earlier",
    description: "Move the last attachment one place earlier.",
    context: "composer",
    defaultBinding: null,
    keywords: ["attachment", "reorder"],
    availability: (state) =>
      state.hasAttachments ? AVAILABLE : unavailable("there is no attachment to reorder"),
  },
  {
    id: "composer.moveAttachmentLater",
    title: "Move attachment later",
    description: "Move the last attachment one place later.",
    context: "composer",
    defaultBinding: null,
    keywords: ["attachment", "reorder"],
    availability: (state) =>
      state.hasAttachments ? AVAILABLE : unavailable("there is no attachment to reorder"),
  },
  {
    id: "composer.enhancePrompt",
    title: "Enhance the draft",
    description: "Propose a clearer draft without submitting it.",
    context: "composer",
    defaultBinding: null,
    keywords: ["enhance", "improve", "rewrite", "clarify"],
    availability: () => AVAILABLE,
  },
  {
    id: "composer.acceptEnhancement",
    title: "Accept enhancement",
    description: "Replace the draft with the proposed text. Does not submit.",
    context: "composer",
    defaultBinding: null,
    keywords: ["accept", "apply", "proposal"],
    availability: (state) =>
      state.hasReadyEnhancement
        ? AVAILABLE
        : unavailable("there is no ready enhancement to accept"),
  },
  {
    id: "composer.rejectEnhancement",
    title: "Reject enhancement",
    description: "Drop the proposal and keep the current draft.",
    context: "composer",
    defaultBinding: null,
    keywords: ["reject", "discard", "proposal"],
    availability: (state) =>
      state.hasEnhancement || state.hasEnhancementFeedback
        ? AVAILABLE
        : unavailable("there is no enhancement to reject"),
  },
  {
    id: "confirmation.accept",
    title: "Accept",
    description: "Confirm the exact action described.",
    context: "confirmation",
    defaultBinding: null,
    keywords: ["yes", "confirm", "ok"],
    availability: (state) => {
      if (!state.hasConfirmation) {
        return unavailable("nothing is waiting for confirmation");
      }
      if (state.confirmationStale) {
        return unavailable("this confirmation is no longer valid");
      }
      if (state.confirmationNeedsSecret) {
        return unavailable("the secret field is empty");
      }
      return AVAILABLE;
    },
  },
  {
    id: "confirmation.deny",
    title: "Decline",
    description: "Refuse the action described.",
    context: "confirmation",
    defaultBinding: null,
    keywords: ["no", "cancel", "refuse"],
    availability: (state) =>
      state.hasConfirmation ? AVAILABLE : unavailable("nothing is waiting for confirmation"),
  },
];
