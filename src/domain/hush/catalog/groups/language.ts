/** Ordered Hush catalog group preserving executable matcher precedence. */

import { APPLE_BUILD_POLICY } from "../apple/build.ts";
import { APPLE_TEST_POLICY } from "../apple/test.ts";
import type { HushCatalogEntry } from "../contracts.ts";
import { DOTNET_BUILD_POLICY } from "../dotnet/build.ts";
import { DOTNET_DIAGNOSTIC_POLICY } from "../dotnet/diagnostic.ts";
import { DOTNET_TEST_POLICY } from "../dotnet/test.ts";
import { ELIXIR_BUILD_POLICY } from "../elixir/build.ts";
import { ELIXIR_DIAGNOSTIC_POLICY } from "../elixir/diagnostic.ts";
import { GO_BUILD_POLICY } from "../go/build.ts";
import { GO_DIAGNOSTIC_POLICY } from "../go/diagnostic.ts";
import { GO_TEST_POLICY } from "../go/test.ts";
import { JVM_BUILD_POLICY } from "../jvm/build.ts";
import { JVM_TEST_POLICY } from "../jvm/test.ts";
import { NATIVE_BUILD_POLICY } from "../native/build.ts";
import { PHP_COMMAND_POLICY } from "../php/command.ts";
import { PHP_DIAGNOSTIC_POLICY } from "../php/diagnostic.ts";
import { PHP_TEST_POLICY } from "../php/test.ts";
import { PYTHON_DIAGNOSTIC_POLICY } from "../python/diagnostic.ts";
import { PYTHON_PACKAGE_POLICY } from "../python/package.ts";
import { PYTHON_TEST_POLICY } from "../python/test.ts";
import { RUBY_DIAGNOSTIC_POLICY } from "../ruby/diagnostic.ts";
import { RUBY_TEST_POLICY } from "../ruby/test.ts";
import { RUST_BUILD_POLICY } from "../rust/build.ts";
import { RUST_DIAGNOSTIC_POLICY } from "../rust/diagnostic.ts";
import { RUST_TEST_POLICY } from "../rust/test.ts";

export const LANGUAGE_COMMANDS = [
  RUST_TEST_POLICY,
  RUST_DIAGNOSTIC_POLICY,
  RUST_BUILD_POLICY,
  PYTHON_TEST_POLICY,
  PYTHON_DIAGNOSTIC_POLICY,
  PYTHON_PACKAGE_POLICY,
  GO_TEST_POLICY,
  GO_DIAGNOSTIC_POLICY,
  GO_BUILD_POLICY,
  JVM_TEST_POLICY,
  JVM_BUILD_POLICY,
  DOTNET_TEST_POLICY,
  DOTNET_DIAGNOSTIC_POLICY,
  DOTNET_BUILD_POLICY,
  APPLE_TEST_POLICY,
  APPLE_BUILD_POLICY,
  NATIVE_BUILD_POLICY,
  ELIXIR_DIAGNOSTIC_POLICY,
  ELIXIR_BUILD_POLICY,
  PHP_TEST_POLICY,
  PHP_DIAGNOSTIC_POLICY,
  PHP_COMMAND_POLICY,
  RUBY_TEST_POLICY,
  RUBY_DIAGNOSTIC_POLICY,
] as const satisfies readonly HushCatalogEntry[];
