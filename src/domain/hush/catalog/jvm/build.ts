/** Hush command-catalog policy for jvm.build. */

import type { HushCatalogEntry } from "../contracts.ts";

export const JVM_BUILD_POLICY = {
  reducerId: "jvm.build",
  family: "build",
  projection: "build",
  executables: ["gradle", "gradlew", "mvn", "mvnw", "sbt"],
  examples: [
    "gradlew build",
    "gradle build",
    "gradlew dependencies",
    "mvn compile",
    "mvnw package",
    "mvn package",
    "mvn install",
    "mvn verify",
    "mvn deploy",
    "sbt compile",
    "sbt run",
  ],
} as const satisfies HushCatalogEntry;
