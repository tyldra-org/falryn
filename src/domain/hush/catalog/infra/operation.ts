/** Hush command-catalog policy for infra.operation. */

import type { HushCatalogEntry } from "../contracts.ts";

export const INFRA_OPERATION_POLICY = {
  reducerId: "infra.operation",
  family: "cloud",
  projection: "operation",
  executables: [
    "ansible-playbook",
    "fail2ban-client",
    "helm",
    "iptables",
    "liquibase",
    "pulumi",
    "sops",
    "terraform",
    "tofu",
  ],
  examples: [
    "ansible-playbook site.yml",
    "fail2ban-client status",
    "helm list",
    "iptables -L",
    "liquibase status",
    "pulumi preview",
    "pulumi up",
    "pulumi destroy",
    "pulumi refresh",
    "pulumi stack ls",
    "sops config.yaml",
    "terraform plan",
    "tofu fmt",
    "tofu init",
    "tofu plan",
    "tofu validate",
  ],
} as const satisfies HushCatalogEntry;
