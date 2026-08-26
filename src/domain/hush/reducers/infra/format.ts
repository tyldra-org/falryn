/** Command-aware infrastructure formatting with exact fallback on unknown shapes. */

import { formatAnsiblePlaybook } from "./ansible.ts";
import { formatPulumi } from "./pulumi.ts";
import { formatFail2banStatus, formatLiquibaseStatus } from "./status.ts";
import { formatInfrastructureTable, formatIptablesListing } from "./tables.ts";
import { formatTerraformLike } from "./terraform.ts";

export const INFRASTRUCTURE_EXECUTABLES = new Set([
  "ansible-playbook",
  "fail2ban-client",
  "helm",
  "iptables",
  "liquibase",
  "pulumi",
  "sops",
  "terraform",
  "tofu",
]);

export function formatInfrastructureOutput(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const executable = commandTokens[0]?.split(/[\\/]/u).at(-1);
  switch (executable) {
    case "ansible-playbook":
      return formatAnsiblePlaybook(text);
    case "fail2ban-client":
      return commandTokens[1] === "status" ? formatFail2banStatus(text) : null;
    case "helm":
      return commandTokens[1] === "list" ? formatInfrastructureTable(text) : null;
    case "iptables":
      return commandTokens.includes("-L") || commandTokens.includes("--list")
        ? formatIptablesListing(text)
        : null;
    case "liquibase":
      return commandTokens.includes("status") ? formatLiquibaseStatus(text) : null;
    case "pulumi":
      return formatPulumi(text, commandTokens);
    case "terraform":
    case "tofu":
      return formatTerraformLike(text, commandTokens);
    default:
      return null;
  }
}
