/** Role navigation and edits over the application settings service. */
import type { SelectOption, SelectRenderable } from "@opentui/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type {
  ModelSettingsRequest,
  ModelSettingsResult,
  ModelSettingsService,
} from "../../application/providers/model-settings.ts";
import { modelSettingsLines } from "../../application/providers/model-settings-format.ts";
import type { ModelSelectionTarget } from "../../providers/configuration/model-selection.ts";
import { REASONING_EFFORTS } from "../../providers/configuration/policy.ts";
import {
  FAST_OPTIONS,
  MODEL_ROLES,
  SUBAGENT_PRESETS,
} from "../../providers/configuration/roles.ts";
import { useFrame } from "../shell/context.tsx";
import { Line } from "../visual/primitives.tsx";
import { useSelectNavigation } from "./select-navigation.ts";

type Page =
  | { readonly kind: "roles" }
  | { readonly kind: "group"; readonly role: "fast" | "subagents" | "workflows" }
  | {
      readonly kind: "advanced";
      readonly catalog: "agent" | "workflow";
      readonly search: string;
      readonly offset: number;
      readonly searching?: boolean;
    }
  | { readonly kind: "target"; readonly target: ModelSelectionTarget }
  | { readonly kind: "membership"; readonly id: string }
  | {
      readonly kind: "edit";
      readonly target: ModelSelectionTarget;
      readonly field: number;
      readonly values: readonly string[];
      readonly expectedRevision: string | null;
    };
type Inspection = Extract<ModelSettingsResult, { kind: "inspection" }>;
type MenuItem = { readonly title: string; readonly detail: string; readonly run: () => void };

export function ModelSettingsSheet({
  service,
  rows,
}: {
  readonly service: ModelSettingsService | null;
  readonly rows: number;
}): ReactNode {
  const { terminal } = useFrame();
  const [page, setPage] = useState<Page>({ kind: "roles" });
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    setInspection(null);
    if (service !== null) {
      const request: ModelSettingsRequest =
        page.kind === "advanced"
          ? { kind: "inspect", catalog: page.catalog, search: page.search, offset: page.offset }
          : page.kind === "target" || page.kind === "edit"
            ? { kind: "inspect", target: page.target }
            : { kind: "inspect" };
      void service
        .execute(request, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.kind === "inspection") setInspection(result);
          else setNotice(modelSettingsLines(result).join(" "));
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setNotice("Model settings are unavailable. Retry after checking configuration.");
        });
    }
    return () => controller.abort();
  }, [service, page]);
  const write = (request: unknown, after: Page = { kind: "roles" }): void => {
    if (service === null || busy) return;
    setBusy(true);
    void service
      .execute(request, lifetime.current.signal)
      .then((result) => {
        if (lifetime.current.signal.aborted) return;
        setNotice(modelSettingsLines(result).join(" "));
        setBusy(false);
        if (result.kind === "written") {
          setPage(after);
        }
      })
      .catch(() => {
        if (!lifetime.current.signal.aborted) {
          setBusy(false);
          setNotice("Settings write could not be confirmed. Inspect before retrying.");
        }
      });
  };
  const targetItem = (title: string, target: ModelSelectionTarget): MenuItem => ({
    title,
    detail: "Inspect inheritance, configure a model, or reset this override.",
    run: () => setPage({ kind: "target", target }),
  });
  const items: MenuItem[] = [];
  if (page.kind === "roles") {
    for (const role of MODEL_ROLES) {
      items.push(
        role === "fast" || role === "subagents" || role === "workflows"
          ? {
              title: role,
              detail: "Default and independent options",
              run: () => setPage({ kind: "group", role }),
            }
          : targetItem(role, { kind: "role", role }),
      );
    }
  } else if (page.kind === "group") {
    items.push(targetItem("Default", { kind: "role", role: page.role }));
    if (page.role === "fast")
      for (const option of FAST_OPTIONS) items.push(targetItem(option, { kind: "fast", option }));
    if (page.role === "subagents")
      for (const preset of SUBAGENT_PRESETS)
        items.push(
          targetItem(preset[0]?.toUpperCase() + preset.slice(1), { kind: "preset", preset }),
        );
    if (page.role !== "fast")
      items.push({
        title: "Advanced",
        detail: "Search actual definitions and retained unavailable preferences.",
        run: () => {
          setDraft("");
          setPage({
            kind: "advanced",
            catalog: page.role === "subagents" ? "agent" : "workflow",
            search: "",
            offset: 0,
          });
        },
      });
  } else if (page.kind === "advanced") {
    items.push({
      title: "Search definitions",
      detail: "Filter by identity or label",
      run: () => setPage({ ...page, searching: true }),
    });
    for (const entry of inspection?.catalog?.entries ?? [])
      items.push(
        targetItem(
          entry.definition === null
            ? entry.id
            : `${entry.definition.label} · ${entry.id} (${entry.definition.provenance})`,
          {
            kind: page.catalog === "agent" ? "agent" : "workflow",
            id: entry.id,
          },
        ),
      );
    if (inspection?.catalog?.nextOffset !== null && inspection?.catalog?.nextOffset !== undefined)
      items.push({
        title: "Next page",
        detail: "More registered or retained definitions",
        run: () => setPage({ ...page, offset: inspection.catalog?.nextOffset ?? 0 }),
      });
    if (page.offset > 0)
      items.push({
        title: "Previous page",
        detail: "Previous definitions",
        run: () => setPage({ ...page, offset: Math.max(0, page.offset - 50) }),
      });
  } else if (page.kind === "target") {
    const target = page.target;
    const selection = inspection?.rows[0]?.selection;
    const route = selection?.kind === "route" ? selection.route : null;
    if (selection?.kind !== "no-model") {
      items.push({
        title: "Configure model",
        detail: "Set this provider profile, model and thinking together.",
        run: () => {
          if (inspection === null) return;
          const values =
            route === null
              ? ["", "", ""]
              : [route.providerProfileId, String(route.providerId), String(route.modelId)];
          setDraft(values[0] ?? "");
          setPage({
            kind: "edit",
            target,
            field: 0,
            values,
            expectedRevision: inspection.fileRevision,
          });
        },
      });
      items.push({
        title: "Reset model override",
        detail: "Reveal inheritance and preserve other preferences.",
        run: () => {
          if (inspection !== null)
            write({
              kind: "edit",
              edit: { kind: "reset", target },
              expectedRevision: inspection.fileRevision,
            });
        },
      });
    }
    if (target.kind === "agent")
      items.push({
        title: "Preset membership",
        detail: "An explicit model keeps precedence over its preset.",
        run: () => setPage({ kind: "membership", id: target.id }),
      });
    if (target.kind === "fast" && (target.option === "memory" || target.option === "compaction")) {
      const option = target.option;
      for (const use of ["evaluated", "off"] as const)
        items.push({
          title:
            use === "off" ? "Turn model-assisted use off" : "Allow evaluated model-assisted use",
          detail: "The workload owner still decides whether this operation can run.",
          run: () => {
            if (inspection !== null)
              write({
                kind: "edit",
                edit: { kind: "use", option, use },
                expectedRevision: inspection.fileRevision,
              });
          },
        });
    }
    const definition = inspection?.rows[0]?.definition;
    if (definition?.kind === "workflow")
      for (const node of definition.nodes)
        items.push(
          targetItem(`${node.key} (${node.kind})`, {
            kind: "step",
            id: definition.id,
            key: node.key,
          }),
        );
  } else if (page.kind === "membership") {
    for (const preset of ["default", ...SUBAGENT_PRESETS, null] as const)
      items.push({
        title: preset ?? "Reset membership",
        detail: "Preserve any explicit model override.",
        run: () => {
          if (inspection !== null)
            write({
              kind: "edit",
              edit: { kind: "membership", id: page.id, preset },
              expectedRevision: inspection.fileRevision,
            });
        },
      });
  } else if (page.kind === "edit" && page.field === 3) {
    for (const reasoning of REASONING_EFFORTS)
      items.push({
        title: reasoning,
        detail: "Validate this exact model before saving.",
        run: () => {
          if (inspection === null) return;
          // The service codec validates the untrusted text and model compatibility.
          const request = {
            kind: "edit",
            edit: {
              kind: "configure",
              target: page.target,
              route: {
                providerProfileId: page.values[0],
                providerId: page.values[1],
                modelId: page.values[2],
                reasoning,
              },
            },
            expectedRevision: page.expectedRevision,
          };
          write(request, { kind: "target", target: page.target });
        },
      });
  }
  if (page.kind !== "roles")
    items.push({
      title: "Back to roles",
      detail: "Keep saved preferences",
      run: () => setPage({ kind: "roles" }),
    });
  const columns = Math.max(8, terminal.columns - 4);
  if (rows === 0) return null;
  if (service === null)
    return (
      <Line color="mutedForeground" maxColumns={columns}>
        Model settings are not attached.
      </Line>
    );
  const editing = page.kind === "edit" && page.field < 3;
  const summary =
    page.kind === "target" && inspection !== null ? modelSettingsLines(inspection).slice(2) : [];
  const top = [
    notice ||
      (busy
        ? "Saving…"
        : inspection === null
          ? "Reading model settings…"
          : "Configuration never launches work."),
    ...summary,
  ].slice(0, Math.min(4, Math.max(1, rows - 3)));
  const inputRows = editing || page.kind === "advanced" ? 1 : 0;
  return (
    <box flexDirection="column" height={rows}>
      {top.map((line) => (
        <Line key={line} color="mutedForeground" maxColumns={columns} untrusted>
          {line}
        </Line>
      ))}
      {editing ? (
        <input
          key={page.field}
          value={draft}
          focused={!busy}
          placeholder={
            ["Provider profile", "Provider identity", "Model identity"][page.field] ?? "Identity"
          }
          onInput={(value) => {
            if (value.length <= 4096) setDraft(value);
            else setNotice("The identity exceeds 4096 characters.");
          }}
          onSubmit={(value) => {
            if (typeof value !== "string") return;
            if (value.trim() === "" || value.length > 4096) {
              setNotice("Enter a non-empty identity.");
              return;
            }
            const values = [...page.values];
            values[page.field] = value.trim();
            setPage({ ...page, field: page.field + 1, values });
            setDraft(values[page.field + 1] ?? "");
          }}
        />
      ) : null}
      {page.kind === "advanced" ? (
        <input
          value={draft}
          focused={!busy && page.searching !== false}
          placeholder="Search definitions; Enter to apply"
          onInput={(value) => {
            if (value.length <= 256) setDraft(value);
            else setNotice("The search query exceeds 256 characters.");
          }}
          onSubmit={() => setPage({ ...page, search: draft, offset: 0, searching: false })}
        />
      ) : null}
      {page.kind === "advanced" && inspection?.catalog?.total === 0 ? (
        <Line color="mutedForeground" maxColumns={columns}>
          No matching registered definitions. Preferences cannot create or launch one.
        </Line>
      ) : null}
      <SettingsMenu
        key={JSON.stringify(page)}
        items={items}
        rows={Math.max(
          0,
          rows -
            top.length -
            inputRows -
            (page.kind === "advanced" && inspection?.catalog?.total === 0 ? 1 : 0),
        )}
        enabled={
          !busy &&
          !editing &&
          inspection !== null &&
          (page.kind !== "advanced" || page.searching === false)
        }
      />
    </box>
  );
}

function SettingsMenu({
  items,
  rows,
  enabled,
}: {
  readonly items: readonly MenuItem[];
  readonly rows: number;
  readonly enabled: boolean;
}): ReactNode {
  const control = useRef<SelectRenderable | null>(null);
  const options: SelectOption[] = items.map((item, index) => ({
    name: item.title,
    description: item.detail,
    value: index,
  }));
  useSelectNavigation(control, items.length, { enabled });
  if (rows === 0) return null;
  return (
    <select
      ref={control}
      options={options}
      height={rows}
      focused={enabled}
      showScrollIndicator
      showDescription={rows >= 4}
      onSelect={(_index, option) => {
        if (typeof option?.value === "number") items[option.value]?.run();
      }}
    />
  );
}
