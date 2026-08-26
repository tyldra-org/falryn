/** Compiled-language test, diagnostic, and build rules. */

import { reduceBuild, reduceDiagnostic, reduceTest } from "../reducers/entrypoints.ts";
import { defineCommandRule } from "./contracts.ts";

export const RUST_RULES = [
  defineCommandRule(
    {
      reducerId: "rust.test",
      family: "test",
      projection: "test",
      executables: ["cargo"],
      examples: ["cargo test", "cargo nextest run"],
      matches: (tokens) => tokens[1] === "test" || (tokens[1] === "nextest" && tokens[2] === "run"),
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "rust.diagnostic",
      family: "lint",
      projection: "diagnostic",
      executables: ["cargo", "clippy"],
      examples: ["cargo clippy", "cargo check", "cargo fmt --check", "clippy"],
      matches: (tokens) => ["check", "clippy", "fmt"].includes(tokens[1] ?? "clippy"),
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "rust.build",
      family: "build",
      projection: "build",
      executables: ["cargo"],
      examples: ["cargo build", "cargo install ripgrep"],
    },
    reduceBuild,
  ),
] as const;

export const GO_RULES = [
  defineCommandRule(
    {
      reducerId: "go.test",
      family: "test",
      projection: "test",
      executables: ["go"],
      examples: ["go test ./..."],
      matches: (tokens) => tokens[1] === "test",
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "go.diagnostic",
      family: "lint",
      projection: "diagnostic",
      executables: ["go", "golangci-lint", "golangci"],
      examples: ["go vet ./...", "golangci-lint run", "golangci run"],
      matches: (tokens) => tokens[0] !== "go" || tokens[1] === "vet",
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "go.build",
      family: "build",
      projection: "build",
      executables: ["go"],
      examples: ["go build ./..."],
    },
    reduceBuild,
  ),
] as const;

export const JVM_RULES = [
  defineCommandRule(
    {
      reducerId: "jvm.test",
      family: "test",
      projection: "test",
      executables: ["gradle", "gradlew", "mvn", "mvnw", "sbt"],
      examples: ["gradlew test", "mvn test", "mvn integration-test", "sbt test"],
      matches: (tokens) => tokens.some((token) => /test/i.test(token)),
    },
    reduceTest,
  ),
  defineCommandRule(
    {
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
    },
    reduceBuild,
  ),
] as const;

export const DOTNET_RULES = [
  defineCommandRule(
    {
      reducerId: "dotnet.test",
      family: "test",
      projection: "test",
      executables: ["dotnet"],
      examples: ["dotnet test"],
      matches: (tokens) => tokens[1] === "test",
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "dotnet.diagnostic",
      family: "lint",
      projection: "diagnostic",
      executables: ["dotnet"],
      examples: ["dotnet format"],
      matches: (tokens) => tokens[1] === "format",
    },
    reduceDiagnostic,
  ),
  defineCommandRule(
    {
      reducerId: "dotnet.build",
      family: "build",
      projection: "build",
      executables: ["dotnet"],
      examples: ["dotnet build", "dotnet restore"],
    },
    reduceBuild,
  ),
] as const;

export const APPLE_AND_NATIVE_RULES = [
  defineCommandRule(
    {
      reducerId: "apple.test",
      family: "test",
      projection: "test",
      executables: ["swift", "xcodebuild"],
      examples: ["swift test", "xcodebuild test"],
      matches: (tokens) => tokens.includes("test"),
    },
    reduceTest,
  ),
  defineCommandRule(
    {
      reducerId: "apple.build",
      family: "build",
      projection: "build",
      executables: ["swift", "xcodebuild"],
      examples: ["swift build", "xcodebuild build"],
    },
    reduceBuild,
  ),
  defineCommandRule(
    {
      reducerId: "native.build",
      family: "build",
      projection: "build",
      executables: ["gcc", "g++", "pio", "quarto", "trunk"],
      examples: ["gcc main.c", "g++ main.cpp", "pio run", "quarto render", "trunk build"],
    },
    reduceBuild,
  ),
] as const;
