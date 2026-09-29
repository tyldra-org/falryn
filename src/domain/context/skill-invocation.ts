/**
 * Explicit skill invocation (#1179). Only host-admitted user input is parsed here:
 * text a model, repository instruction, template expansion or scheduler produces
 * never reaches these functions, so it cannot manufacture user origin.
 */

/** The namespace that always reaches a skill, whatever else shares its name. */
export const SKILL_COMMAND_NAMESPACE = "skill";

/** Agent Skills names: lowercase words joined by single hyphens, at most 64 characters. */
const SKILL_NAME = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const INVOCATION = /^\/([a-z0-9][a-z0-9:-]{0,127})(?:[ \t\r\n]+([\s\S]*))?$/u;

export const SKILLS_COMMAND = /^\/skills(?:[ \t]+([\s\S]*))?$/u;

export const SKILL_CATALOG_LIMITS = Object.freeze({
  /** Entries in one page of `/skills`. */
  page: 100,
  /** Bytes of one rendered page. */
  pageBytes: 262_144,
});

export type SkillCommand =
  | { readonly kind: "skill"; readonly name: string; readonly qualified: boolean }
  /** A bare name that is both a skill and a prompt template: the user must qualify it. */
  | { readonly kind: "ambiguous"; readonly name: string };

/**
 * Whether submitted text invokes a skill. `/skill:<name>` always does. A bare
 * `/<name>` does only when a skill of that name exists; when a prompt template has
 * the same alias it is ambiguous. Anything else is left to the caller's next owner.
 * Built-in commands are checked by the caller first and always win.
 */
export function resolveSkillCommand(
  text: string,
  catalog: { readonly skills: ReadonlySet<string>; readonly templates: ReadonlySet<string> },
): SkillCommand | null {
  const matched = INVOCATION.exec(text.trim());
  const token = matched?.[1];
  if (token === undefined || SKILLS_COMMAND.test(text.trim())) return null;
  const qualifiedPrefix = `${SKILL_COMMAND_NAMESPACE}:`;
  if (token.startsWith(qualifiedPrefix)) {
    const name = token.slice(qualifiedPrefix.length);
    return SKILL_NAME.test(name) && name.length <= 64
      ? { kind: "skill", name, qualified: true }
      : null;
  }
  if (token.includes(":") || !SKILL_NAME.test(token) || !catalog.skills.has(token)) return null;
  return catalog.templates.has(token)
    ? { kind: "ambiguous", name: token }
    : { kind: "skill", name: token, qualified: false };
}

/** `/skills [filter] [after N]`: an optional name filter and page offset. */
export function parseSkillsCommand(
  text: string,
): { readonly filter: string | null; readonly offset: number } | null {
  const matched = SKILLS_COMMAND.exec(text.trim());
  if (matched === null) return null;
  let rest = matched[1]?.trim() ?? "";
  let offset = 0;
  const paged = /(?:^|\s)after\s+(\d{1,6})$/u.exec(rest);
  if (paged !== null) {
    offset = Number(paged[1]);
    rest = rest.slice(0, paged.index).trim();
  }
  return { filter: rest === "" ? null : rest.slice(0, 64), offset };
}

/** One skill source in the catalog, as it stands; its body is never read to list it. */
export type SkillCatalogEntry = {
  readonly name: string;
  /** The instruction source key. */
  readonly source: string;
  readonly origin: string;
  /** The entrypoint relative to its root. */
  readonly path: string;
  readonly scope: string;
  /** How name resolution treats this source now. */
  readonly state: "selected" | "shadowed" | "excluded" | "conflicting";
  readonly reason: string;
  /** Declared eligibility; null when the entrypoint could not be read or parsed. */
  readonly userInvocable: boolean | null;
  readonly automatic: boolean | null;
  /** The command that invokes it, or null when a user cannot invoke it. */
  readonly command: string | null;
};

export type SkillCatalogPage = {
  readonly generation: string;
  readonly entries: readonly SkillCatalogEntry[];
  readonly total: number;
  readonly nextOffset: number | null;
};

/** Human lines for `/skills`, bounded to one page's byte limit. */
export function skillCatalogLines(page: SkillCatalogPage | null, filter: string | null): string[] {
  if (page === null) return ["No skill catalog is available for this session yet."];
  if (page.entries.length === 0)
    return [
      filter === null
        ? "No skills were found in this workspace or your user skill folders."
        : `No skills match "${filter}".`,
    ];
  const lines = [
    `Skills (${page.entries.length} of ${page.total}${filter === null ? "" : ` matching "${filter}"`}). Invoke one with its command; /skill:<name> always reaches a skill.`,
  ];
  let bytes = 0;
  for (const entry of page.entries) {
    // Declared ineligibility reads as such; other exclusions keep their resolver reason.
    const status =
      entry.command !== null
        ? entry.command
        : entry.userInvocable === false
          ? "not user-invocable (user-invocable: false, or restricted by preferences)"
          : `${entry.state}: ${entry.reason}`;
    const eligibility =
      entry.userInvocable === null
        ? ""
        : ` [user ${entry.userInvocable ? "yes" : "no"}, automatic ${entry.automatic ? "yes" : "no"}]`;
    const line = `${entry.name} — ${status} — ${entry.origin} ${entry.path}${eligibility}`;
    bytes += new TextEncoder().encode(line).byteLength + 1;
    if (bytes > SKILL_CATALOG_LIMITS.pageBytes) {
      lines.push("The rest of this page exceeds 256 KiB; narrow it with /skills <name>.");
      return lines;
    }
    lines.push(line);
  }
  if (page.nextOffset !== null)
    lines.push(
      `More skills: /skills ${filter === null ? "" : `${filter} `}after ${page.nextOffset}`,
    );
  return lines;
}
