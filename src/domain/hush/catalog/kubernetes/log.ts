/** Hush command-catalog policy for kubernetes.log. */

import { parseKubernetesCommand } from "../../kubernetes-command.ts";
import type { HushCatalogEntry } from "../contracts.ts";

export const KUBERNETES_LOG_POLICY = {
  reducerId: "kubernetes.log",
  family: "kubernetes",
  projection: "log",
  executables: ["kubectl", "oc"],
  examples: ["kubectl logs pod", "oc logs pod"],
  matches: (tokens) => parseKubernetesCommand(tokens)?.verb === "logs",
} as const satisfies HushCatalogEntry;
