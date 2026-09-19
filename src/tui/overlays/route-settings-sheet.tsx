/** Route controls use the same bounded action schema as CLI and attached hosts. */
import { useEffect, useRef, useState } from "react";
import type { ModelSettingsService } from "../../application/providers/model-settings.ts";
import { modelSettingsLines } from "../../application/providers/model-settings-format.ts";
import { routeSettingsRequests } from "../../application/providers/route-settings.ts";
import { Line } from "../visual/primitives.tsx";

export function RouteSettingsSheet({
  service,
  rows,
  onBack,
}: {
  readonly service: ModelSettingsService;
  readonly rows: number;
  readonly onBack: () => void;
}) {
  const [lines, setLines] = useState<readonly string[]>([]);
  const [draft, setDraft] = useState('{"kind":"route-list"}');
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    void service
      .execute({ kind: "route-list" }, lifetime.current.signal)
      .then((result) => {
        if (!lifetime.current.signal.aborted) setLines(modelSettingsLines(result));
      })
      .catch(() => {
        if (!lifetime.current.signal.aborted) setLines(["Route settings unavailable."]);
      });
    return () => lifetime.current.abort();
  }, [service]);
  return (
    <box flexDirection="column" height={rows}>
      <Line>Route JSON action. Select routes under a model role. Enter back to return.</Line>
      <Line>{routeSettingsRequests.map((schema) => schema.shape.kind.value).join(", ")}</Line>
      <input
        value={draft}
        focused={!busy}
        onInput={(value) => {
          if (value.length <= 65_536) setDraft(value);
        }}
        onSubmit={(value) => {
          if (busy || typeof value !== "string" || value.length > 65_536) return;
          if (value.trim() === "back") {
            onBack();
            return;
          }
          let request: unknown;
          try {
            request = JSON.parse(value);
          } catch {
            setLines(["Enter a JSON route action."]);
            return;
          }
          if (!routeSettingsRequests.some((schema) => schema.safeParse(request).success)) {
            setLines(["Invalid route action."]);
            return;
          }
          setBusy(true);
          void service
            .execute(request, lifetime.current.signal)
            .then((result) => {
              if (!lifetime.current.signal.aborted) {
                setLines(modelSettingsLines(result));
                setBusy(false);
              }
            })
            .catch(() => {
              if (!lifetime.current.signal.aborted) {
                setLines(["Action could not be confirmed. Inspect before retrying."]);
                setBusy(false);
              }
            });
        }}
      />
      {[...new Set(lines)].slice(0, Math.max(0, rows - 5)).map((line) => (
        <Line key={line} untrusted>
          {line}
        </Line>
      ))}
    </box>
  );
}
