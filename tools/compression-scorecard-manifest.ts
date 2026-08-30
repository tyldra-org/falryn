/** Immutable baseline and live-path manifest for the #828 qualification report. */

import {
  CAVEMAN_ADAPTER_VERSION,
  CAVEMAN_PINNED_COMMIT,
  CAVEMAN_PINNED_SKILL_DIGEST,
} from "../src/application/index.ts";
import { HEADROOM_LOOM_BASELINE } from "./fixtures/headroom-loom-baseline.ts";
import { HUSH_RTK_BASELINE } from "./hush-command-coverage.ts";

export const COMPRESSION_SCORECARD_SCHEMA_VERSION = 1;
export const COMPRESSION_SCORECARD_MANIFEST_VERSION = "compression-live.v1";

export const COMPRESSION_PRODUCT_PATH_TESTS = [
  "src/application/product-attempt-runner.test.ts",
  "src/application/product-read.test.ts",
  "src/application/product-tools-process.test.ts",
  "src/cli/coding-run.test.ts",
] as const;

export const COMPRESSION_SCORECARD_MANIFEST = {
  schemaVersion: COMPRESSION_SCORECARD_SCHEMA_VERSION,
  version: COMPRESSION_SCORECARD_MANIFEST_VERSION,
  tokenKinds: {
    hush: "estimated",
    loom: "estimated",
    brief: "provider-reported",
  },
  hush: {
    inventoryBaseline: HUSH_RTK_BASELINE,
    executableBaseline: "rtk 0.46.0",
    tokenizer: "ceil(utf8-bytes/4)",
  },
  loom: {
    baseline: {
      package: HEADROOM_LOOM_BASELINE.package,
      version: HEADROOM_LOOM_BASELINE.version,
      sourceSha256: HEADROOM_LOOM_BASELINE.sourceSha256,
    },
    tokenizer: "ceil(utf8-bytes/4)",
  },
  brief: {
    baseline: {
      commit: CAVEMAN_PINNED_COMMIT,
      sourceDigest: CAVEMAN_PINNED_SKILL_DIGEST,
      adapterVersion: CAVEMAN_ADAPTER_VERSION,
    },
    qualificationFixture: "brief-qualification-commandcode-minimax-m3.json",
  },
  productPathTests: COMPRESSION_PRODUCT_PATH_TESTS,
  limits: {
    productPathTimeoutMs: 180_000,
    subprocessConcurrency: 1,
  },
} as const;
