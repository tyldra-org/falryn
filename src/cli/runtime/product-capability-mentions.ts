/**
 * The host's `$` capability mentions (#1206): candidates from the owners that already
 * know them, the composer's suggestion source, and admission of picked tokens.
 *
 * Skills come from the instruction owner's metadata-only catalog, packages from the
 * current Extensions publication, and MCP servers from configuration and the MCP
 * catalog. Listing reads metadata only. Admission connects a picked server whose
 * catalog is not current, as the user's own request, and nothing else.
 */
import {
  admitCapabilityMentions,
  type CapabilityMentionAdmission,
  type CapabilityMentionCandidate,
  rankCapabilityMentions,
} from "../../domain/context/capability-mentions.ts";
import type { ComposerToken } from "../../domain/context/composer-mentions.ts";
import type { SkillCatalogPage } from "../../domain/context/skill-invocation.ts";
import type { ExtensionCatalog } from "../../domain/extensions/catalog.ts";
import type { McpConnection } from "../../domain/extensions/mcp.ts";
import type { ComposerSuggestionSource, SuggestionRow } from "../../tui/composer/suggestions.ts";

export type CapabilityMentionPorts = {
  /**
   * Every page of the skill catalog. The owner publishes it lazily, so a first read
   * may wait for that publication; null when there is none.
   */
  readonly skills: (signal: AbortSignal) => Promise<readonly SkillCatalogPage[] | null>;
  /** The current Extensions publication, if packages are published in this session. */
  readonly packages: () => ExtensionCatalog | undefined;
  readonly mcp: {
    readonly servers: () => readonly McpConnection[];
    readonly generation: () => number;
    readonly catalogState: (serverId: string) => "current" | "stale" | "unknown";
    /** The MCP tools a picked server is reached through. */
    readonly capabilityIds: () => readonly string[];
    readonly connect: (
      serverId: string,
      signal: AbortSignal,
    ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  };
};

export type CapabilityMentions = {
  readonly candidates: (signal: AbortSignal) => Promise<readonly CapabilityMentionCandidate[]>;
  readonly source: ComposerSuggestionSource;
  readonly admit: (
    tokens: readonly ComposerToken[],
    signal: AbortSignal,
  ) => Promise<CapabilityMentionAdmission>;
};

function skillCandidates(pages: readonly SkillCatalogPage[] | null): CapabilityMentionCandidate[] {
  if (pages === null) return [];
  return pages.flatMap((page) =>
    page.entries.map((entry): CapabilityMentionCandidate => {
      const reason =
        entry.userInvocable === null
          ? "its entrypoint could not be read"
          : !entry.userInvocable
            ? "not user-invocable"
            : entry.state === "shadowed"
              ? "shadowed by a higher-priority skill of the same name"
              : entry.state === "excluded"
                ? "restricted in this scope"
                : entry.state === "conflicting"
                  ? "conflicting sources share this name"
                  : null;
      return {
        kind: "skill",
        name: entry.name,
        identity: entry.source,
        generation: page.generation,
        source: `skill · ${entry.scope}`,
        availability:
          reason === null
            ? { kind: "available" }
            : { kind: "unavailable", reason, repair: "/skills" },
        capabilityIds: [],
      };
    }),
  );
}

function packageCandidates(catalog: ExtensionCatalog | undefined): CapabilityMentionCandidate[] {
  if (catalog === undefined) return [];
  const byPackage = new Map<string, (typeof catalog.entries)[number][]>();
  for (const entry of catalog.entries) {
    if (entry.source.kind !== "package") continue;
    const key = entry.source.activation.packageIdentityDigest;
    byPackage.set(key, [...(byPackage.get(key) ?? []), entry]);
  }
  return [...byPackage.values()].flatMap((entries) => {
    const first = entries[0];
    if (first === undefined || first.source.kind !== "package") return [];
    const { owner, activation } = first.source;
    const bound = entries.flatMap((entry) =>
      entry.availability === "available" && entry.binding !== null ? [entry.binding.actionId] : [],
    );
    const untrusted = entries.every((entry) => entry.trust !== "accepted");
    const reason =
      bound.length > 0 ? null : untrusted ? "not trusted" : (first.reason ?? "nothing activated");
    return [
      {
        kind: "package",
        name: owner.packageId,
        identity: `${owner.packageId}@${owner.packageDigest}#${activation.activationRevision}`,
        generation: String(catalog.generation),
        source: `package · ${owner.packageId}${owner.packageVersion === null ? "" : ` ${owner.packageVersion}`} · ${activation.scope}`,
        availability:
          reason === null
            ? { kind: "available" }
            : { kind: "unavailable", reason, repair: `/extensions ${owner.packageId}` },
        capabilityIds: bound,
      },
    ];
  });
}

export function composeCapabilityMentions(ports: CapabilityMentionPorts): CapabilityMentions {
  const candidates = async (
    signal: AbortSignal,
  ): Promise<readonly CapabilityMentionCandidate[]> => {
    const mcpIds = ports.mcp.capabilityIds();
    const servers = ports.mcp.servers().map(
      (server): CapabilityMentionCandidate => ({
        kind: "mcp-server",
        name: server.id,
        identity: `mcp:${server.id}`,
        generation: String(ports.mcp.generation()),
        source: `MCP server · ${server.transport}${server.explicitOnly ? " · explicit only" : ""}`,
        availability: server.enabled
          ? { kind: "available" }
          : { kind: "unavailable", reason: "disabled in configuration", repair: "/mcp" },
        capabilityIds: mcpIds,
        catalog: ports.mcp.catalogState(server.id),
      }),
    );
    return [
      ...skillCandidates(await ports.skills(signal)),
      ...packageCandidates(ports.packages()),
      ...servers,
    ];
  };

  const source: ComposerSuggestionSource = {
    trigger: "$",
    async query(query, signal) {
      const page = rankCapabilityMentions(query, await candidates(signal));
      const rows = page.rows.map(
        (row, index): SuggestionRow => ({
          id: `${row.candidate.kind}:${row.candidate.identity}:${index}`,
          label: row.label,
          kind: row.candidate.kind,
          detail: row.candidate.source,
          exact: row.match === "exact",
          unavailable:
            row.candidate.availability.kind === "available"
              ? null
              : {
                  reason: row.candidate.availability.reason,
                  repair: row.candidate.availability.repair,
                },
          pick: {
            trigger: "$",
            kind: row.candidate.kind,
            identity: row.candidate.identity,
            label: row.label,
            source: row.candidate.source,
            generation: row.candidate.generation,
          },
        }),
      );
      return { rows, total: page.total, notice: null };
    },
  };

  const admit = async (
    tokens: readonly ComposerToken[],
    signal: AbortSignal,
  ): Promise<CapabilityMentionAdmission> => {
    const admitted = admitCapabilityMentions(tokens, await candidates(signal));
    if (!admitted.ok || admitted.connect.length === 0) return admitted;
    // A picked server whose catalog is not current is connected once, as the user's
    // own request, before anything reaches the provider.
    for (const serverId of admitted.connect) {
      const connected = await ports.mcp.connect(serverId, signal);
      if (!connected.ok) {
        const token = tokens.find((item) => item.identity === `mcp:${serverId}`);
        return {
          ok: false,
          failures: [
            {
              tokenId: token?.id ?? serverId,
              label: token?.label ?? `$mcp:${serverId}`,
              code: "mention.connect-failed",
              reason: `${token?.label ?? serverId} could not connect (${connected.reason})`,
              repair: "/mcp",
            },
          ],
        };
      }
    }
    return { ...admitted, connect: [] };
  };

  return { candidates, source, admit };
}
