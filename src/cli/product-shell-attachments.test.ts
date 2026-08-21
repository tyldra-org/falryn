/**
 * Default TUI product attachments (#752).
 */

import { describe, expect, test } from "bun:test";

import {
  createInMemoryEventStore,
  createStaticEnvironment,
  createSystemClock,
} from "../domain/index.ts";
import { snapshotOf } from "../tui/composer/index.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";

describe("composeProductShellAttachments", () => {
  test("builds a submission port that accepts a non-empty draft", async () => {
    const attachments = await composeProductShellAttachments({
      eventStore: createInMemoryEventStore(),
      clock: createSystemClock(),
      environment: createStaticEnvironment({}),
      workspaceSet: null,
    });
    expect(attachments).not.toBeNull();
    if (attachments === null) {
      return;
    }
    const outcome = await attachments.submission.submit(snapshotOf("wire me", 1));
    expect(outcome.kind).toBe("accepted");
    expect(attachments.transcriptFeed.events().length).toBeGreaterThan(0);
  });

  test("fails closed for an empty draft without the permanent #707 stub", async () => {
    const attachments = await composeProductShellAttachments({
      eventStore: createInMemoryEventStore(),
      clock: createSystemClock(),
      environment: createStaticEnvironment({}),
      workspaceSet: null,
    });
    expect(attachments).not.toBeNull();
    if (attachments === null) {
      return;
    }
    const outcome = await attachments.submission.submit(snapshotOf("   ", 1));
    expect(outcome.kind).toBe("unavailable");
    if (outcome.kind !== "unavailable") {
      return;
    }
    expect(outcome.reason).toContain("empty");
    expect(outcome.owner).toBe("#707");
    expect(outcome.reason).not.toContain("no agent submission port is attached");
  });
});
