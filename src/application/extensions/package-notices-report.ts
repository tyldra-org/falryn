import type { NoticeAction, PresentedNotice } from "../../domain/security/ecosystem-notice.ts";
import type { PackageNoticesResult } from "./package-notices.ts";

/** What the person runs next for each closed action. Handles stay opaque; this text is display. */
const ACTION_HINTS: Readonly<Record<NoticeAction, string>> = {
  "refresh-evidence":
    "Refresh signed evidence with `falryn extension trust <path> --input <refresh request>`.",
  reapprove:
    "Review the package and approve it again with `falryn extension trust <path> --input <approve request>`.",
  "update-package":
    "Install a fixed or compatible version with `falryn package` (install or update).",
  "rollback-package": "Return to a retained version with `falryn package` (rollback).",
  "recover-health": "Recover the package process with `falryn package` (health with recover).",
  inspect: "Inspect the package with `falryn extension inspect <path>`.",
};

function time(value: number | null): string {
  if (value === null) return "unrecorded";
  const at = new Date(value);
  return Number.isFinite(at.getTime()) ? at.toISOString() : "out of range";
}

function noticeLines(entry: PresentedNotice): string[] {
  const { notice } = entry;
  const subject = `${notice.subject.packageId}@${notice.subject.packageVersion ?? "unversioned"}`;
  if (entry.presentation === "suppressed" && entry.acknowledgement.status === "acknowledged")
    return [
      `Acknowledged until ${time(entry.acknowledgement.expiresAt)}: ${notice.code} for ${subject}. ${
        notice.impact === "invocation-denied"
          ? `Invocation is still denied (${notice.reason ?? "no reason recorded"}).`
          : "This notice does not change the trust decision."
      }`,
      `  Notice: ${notice.id}`,
    ];
  return [
    `[${notice.severity}] ${notice.code} (${notice.state}) for ${subject}`,
    notice.impact === "invocation-denied"
      ? `  Invocation is denied: ${notice.reason ?? "no reason recorded"}.`
      : "  Reported only; it does not change the trust decision, and launching the package may still be refused.",
    `  Evidence (${notice.evidence.basis}): reference ${notice.evidence.reference}${
      notice.evidence.advisory === null ? "" : `; advisory ${notice.evidence.advisory}`
    }${
      notice.evidence.advisorySequence === null
        ? ""
        : `; sequence ${notice.evidence.advisorySequence}`
    }${notice.evidence.advisoryIds.length === 0 ? "" : `; ids ${notice.evidence.advisoryIds.join(", ")}`}${
      notice.evidence.healthState === null ? "" : `; health ${notice.evidence.healthState}`
    }.`,
    `  Freshness: ${notice.freshness.status}; observed ${time(notice.freshness.observedAt)}; expires ${time(notice.freshness.expiresAt)}.`,
    `  Required action: ${notice.requiredAction}. ${ACTION_HINTS[notice.requiredAction]}`,
    ...notice.remediation.map((handle) => `  Remediation: ${handle.kind} (${handle.handle})`),
    `  Notice: ${notice.id}`,
    ...(entry.acknowledgement.status === "expired"
      ? [`  An earlier acknowledgement expired at ${time(entry.acknowledgement.expiresAt)}.`]
      : []),
  ];
}

export function packageNoticeLines(result: PackageNoticesResult): string[] {
  if (result.status === "failed") return [`Extension notices failed: ${result.code}`];
  const shown = result.notices.length - result.suppressed;
  return [
    result.notices.length === 0
      ? "No notices: no advisory, compatibility, dependency or health cause is recorded for this package."
      : `Notices: ${result.notices.length} (${shown} shown, ${result.suppressed} acknowledged). Acknowledging hides a notice, not its effect on invocation.`,
    ...result.notices.flatMap(noticeLines),
    ...(result.status === "preview" && result.confirmation !== null
      ? [`Confirm this exact acknowledgement: ${result.confirmation}`]
      : []),
    ...(result.status === "applied" ? ["Acknowledgement recorded."] : []),
  ];
}
