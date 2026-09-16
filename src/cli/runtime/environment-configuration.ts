import { objectKey } from "../../config/index.ts";
import { ENVIRONMENT_KEY, environmentEditsSchema } from "../../domain/process/environment.ts";

/** The runtime retains contributing layers separately for scoped preparation order. */
export const ENVIRONMENT_CONFIGURATION_KEYS = [
  objectKey({
    path: ENVIRONMENT_KEY,
    summary: "Scoped child environment edits and explicitly enabled local preparation.",
    objectSchema: environmentEditsSchema,
    defaultValue: {},
    scopes: ["user", "project", "profile"],
    applicationClass: "next-operation",
    sensitivity: "sensitive",
    introducedInSchemaVersion: 2,
  }),
] as const;
