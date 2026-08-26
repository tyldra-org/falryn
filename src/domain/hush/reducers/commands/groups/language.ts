/** Ordered command-reducer group mirroring the Hush catalog. */

import { APPLE_BUILD_REDUCER } from "../apple/build.ts";
import { APPLE_TEST_REDUCER } from "../apple/test.ts";
import { DOTNET_BUILD_REDUCER } from "../dotnet/build.ts";
import { DOTNET_DIAGNOSTIC_REDUCER } from "../dotnet/diagnostic.ts";
import { DOTNET_TEST_REDUCER } from "../dotnet/test.ts";
import { ELIXIR_BUILD_REDUCER } from "../elixir/build.ts";
import { ELIXIR_DIAGNOSTIC_REDUCER } from "../elixir/diagnostic.ts";
import { GO_BUILD_REDUCER } from "../go/build.ts";
import { GO_DIAGNOSTIC_REDUCER } from "../go/diagnostic.ts";
import { GO_TEST_REDUCER } from "../go/test.ts";
import { JVM_BUILD_REDUCER } from "../jvm/build.ts";
import { JVM_TEST_REDUCER } from "../jvm/test.ts";
import { NATIVE_BUILD_REDUCER } from "../native/build.ts";
import { PHP_COMMAND_REDUCER } from "../php/command.ts";
import { PHP_DIAGNOSTIC_REDUCER } from "../php/diagnostic.ts";
import { PHP_TEST_REDUCER } from "../php/test.ts";
import { PYTHON_DIAGNOSTIC_REDUCER } from "../python/diagnostic.ts";
import { PYTHON_PACKAGE_REDUCER } from "../python/package.ts";
import { PYTHON_TEST_REDUCER } from "../python/test.ts";
import { RUBY_DIAGNOSTIC_REDUCER } from "../ruby/diagnostic.ts";
import { RUBY_TEST_REDUCER } from "../ruby/test.ts";
import { RUST_BUILD_REDUCER } from "../rust/build.ts";
import { RUST_DIAGNOSTIC_REDUCER } from "../rust/diagnostic.ts";
import { RUST_TEST_REDUCER } from "../rust/test.ts";

export const LANGUAGE_COMMAND_REDUCERS = {
  "rust.test": RUST_TEST_REDUCER,
  "rust.diagnostic": RUST_DIAGNOSTIC_REDUCER,
  "rust.build": RUST_BUILD_REDUCER,
  "python.test": PYTHON_TEST_REDUCER,
  "python.diagnostic": PYTHON_DIAGNOSTIC_REDUCER,
  "python.package": PYTHON_PACKAGE_REDUCER,
  "go.test": GO_TEST_REDUCER,
  "go.diagnostic": GO_DIAGNOSTIC_REDUCER,
  "go.build": GO_BUILD_REDUCER,
  "jvm.test": JVM_TEST_REDUCER,
  "jvm.build": JVM_BUILD_REDUCER,
  "dotnet.test": DOTNET_TEST_REDUCER,
  "dotnet.diagnostic": DOTNET_DIAGNOSTIC_REDUCER,
  "dotnet.build": DOTNET_BUILD_REDUCER,
  "apple.test": APPLE_TEST_REDUCER,
  "apple.build": APPLE_BUILD_REDUCER,
  "native.build": NATIVE_BUILD_REDUCER,
  "elixir.diagnostic": ELIXIR_DIAGNOSTIC_REDUCER,
  "elixir.build": ELIXIR_BUILD_REDUCER,
  "php.test": PHP_TEST_REDUCER,
  "php.diagnostic": PHP_DIAGNOSTIC_REDUCER,
  "php.command": PHP_COMMAND_REDUCER,
  "ruby.test": RUBY_TEST_REDUCER,
  "ruby.diagnostic": RUBY_DIAGNOSTIC_REDUCER,
} as const;
