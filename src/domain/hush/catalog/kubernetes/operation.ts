/** Hush command-catalog policy for kubernetes.operation. */

import type { HushCatalogEntry } from "../contracts.ts";

export const KUBERNETES_OPERATION_POLICY = {
  reducerId: "kubernetes.operation",
  family: "kubernetes",
  projection: "operation",
  executables: ["kubectl", "oc"],
  examples: ["kubectl describe pod app", "kubectl apply -f app.yaml", "oc adm top pods"],
} as const satisfies HushCatalogEntry;
