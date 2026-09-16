import { type ReactNode, useEffect, useState } from "react";
import type {
  ModelSettingsRequest,
  ModelSettingsResult,
  ModelSettingsService,
} from "../../application/providers/model-settings.ts";
import { modelSettingsLines } from "../../application/providers/model-settings-format.ts";
import type { ProcessingRequest } from "../../application/providers/processing-controls.ts";
import type { ProcessingPreference } from "../../domain/sessions/model-processing.ts";
import type { ModelSelectionTarget } from "../../providers/configuration/model-selection.ts";
import { useFrame } from "../shell/context.tsx";
import { Line } from "../visual/primitives.tsx";
import { type MenuItem, SettingsMenu } from "./model-settings-menu.tsx";

type Inspection = Extract<ModelSettingsResult, { kind: "processing-inspection" }>;
export function ProcessingSettingsSheet({
  service,
  rows,
  savedScope,
  target,
  onBack,
}: {
  readonly service: ModelSettingsService;
  readonly rows: number;
  readonly savedScope: "user" | "profile";
  readonly target?: ModelSelectionTarget;
  readonly onBack: () => void;
}): ReactNode {
  const { terminal } = useFrame();
  const [scope, setScope] = useState<ProcessingRequest["scope"]>(
    target ? { kind: savedScope, target } : { kind: "session" },
  );
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<ModelSettingsRequest | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    setInspection(null);
    void service
      .execute(pending ?? { kind: "processing-inspect", scope }, abort.signal)
      .then(async (result) => {
        if (abort.signal.aborted) return;
        if (pending) {
          setNotice(modelSettingsLines(result).join(" "));
          setPending(null);
        } else if (result.kind === "processing-inspection") setInspection(result);
        else setNotice(modelSettingsLines(result).join(" "));
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setNotice("Processing settings unavailable; inspect before retrying.");
          setPending(null);
        }
      });
    return () => abort.abort();
  }, [service, scope, pending]);
  const change = (preference?: ProcessingPreference) => {
    if (!inspection || pending) return;
    setPending(
      preference
        ? {
            kind: "processing-set",
            scope,
            preference: {
              mode: preference.mode ?? "provider-default",
              fallback: preference.fallback ?? "stop",
            },
            ...(scope.kind === "session" ? {} : { expectedRevision: inspection.fileRevision }),
          }
        : {
            kind: "processing-reset",
            scope,
            ...(scope.kind === "session" ? {} : { expectedRevision: inspection.fileRevision }),
          },
    );
  };
  const items: MenuItem[] = (inspection?.selection?.modes ?? []).map((mode) => ({
    title:
      mode.preference.mode === "provider-default"
        ? "Provider default"
        : mode.preference.mode === "fast"
          ? "Fast"
          : "Standard",
    detail: mode.eligible
      ? "Apply for the next request; model and thinking stay unchanged"
      : `Unavailable: ${mode.reason}`,
    run: () => (mode.eligible ? change(mode.preference) : setNotice(`Unavailable: ${mode.reason}`)),
  }));
  for (const fallback of ["stop", "allow-standard"] as const)
    items.push({
      title: fallback === "stop" ? "Local rejection: Stop" : "Local rejection: Allow Standard",
      detail: "Does not prevent provider-internal downgrade",
      run: () => change({ ...inspection?.selection?.preference, fallback }),
    });
  items.push({
    title: "Reset processing override",
    detail: "Remove this preference and reveal inheritance",
    run: () => change(),
  });
  if (!target)
    items.push({
      title: scope.kind === "session" ? `Save ${savedScope} defaults…` : "Session main settings…",
      detail:
        scope.kind === "session"
          ? "Explicit saved scope affects inheriting workloads; select a preference after inspection"
          : "Transient main preference; never saved automatically",
      run: () => {
        setNotice("");
        setScope(scope.kind === "session" ? { kind: savedScope } : { kind: "session" });
      },
    });
  items.push({
    title: "Refresh inspection",
    detail: "Read current revision and eligibility without a provider request",
    run: () => setScope({ ...scope }),
  });
  items.push({ title: "Back to roles", detail: "Keep applied preferences", run: onBack });
  const lines = inspection
    ? modelSettingsLines(inspection)
    : [pending ? "Saving processing preference…" : "Reading processing settings…"];
  const summaryRows = Math.min(Math.max(1, rows - 4), 9);
  const summary = (notice ? [notice, ...lines] : lines).slice(0, summaryRows);
  return (
    <box flexDirection="column" height={rows}>
      {summary.map((line) => (
        <Line
          key={line}
          color="mutedForeground"
          maxColumns={Math.max(8, terminal.columns - 4)}
          untrusted
        >
          {line}
        </Line>
      ))}
      <SettingsMenu
        items={items}
        rows={Math.max(0, rows - summary.length)}
        enabled={inspection !== null && pending === null}
      />
    </box>
  );
}
