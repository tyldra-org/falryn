/** Hush command-catalog policy for kubernetes.table. */

import { parseKubernetesCommand } from "../../kubernetes-command.ts";
import type { HushCatalogEntry } from "../contracts.ts";

export const KUBERNETES_TABLE_POLICY = {
  reducerId: "kubernetes.table",
  family: "kubernetes",
  projection: "table",
  executables: ["kubectl", "oc"],
  examples: ["kubectl get pods", "kubectl pods", "kubectl services", "oc get pods", "oc status"],
  matches: isKubernetesTableCommand,
} as const satisfies HushCatalogEntry;

function isKubernetesTableCommand(tokens: readonly string[]): boolean {
  const command = parseKubernetesCommand(tokens);
  return (
    command !== null &&
    (command.verb === "get" ||
      command.verb === "pods" ||
      command.verb === "services" ||
      (command.executable === "oc" && command.verb === "status"))
  );
}
