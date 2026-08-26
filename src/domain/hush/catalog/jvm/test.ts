/** Hush command-catalog policy for jvm.test. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JVM_TEST_POLICY = {
  reducerId: "jvm.test",
  family: "test",
  projection: "test",
  executables: ["gradle", "gradlew", "mvn", "mvnw", "sbt"],
  examples: ["gradlew test", "mvn test", "mvn integration-test", "sbt test"],
  matches: (tokens) => tokens.some((token) => /test/i.test(token)),
} as const satisfies HushCatalogEntry;
