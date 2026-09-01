/** Human-facing Hush and Loom controls backed by their existing raw modes. */

import { err, ok, type Result } from "../domain/index.ts";
import type { ProductProcessOutputMode } from "./product-process-output.ts";
import type { ProductReadOutputMode } from "./product-read.ts";

export const PRODUCT_ENGINE_FRONTEND_STATES = ["on", "off"] as const;
export type ProductEngineFrontendState = (typeof PRODUCT_ENGINE_FRONTEND_STATES)[number];

export type ProductOutputControlError = {
  readonly code: "unsupported-output-state";
  readonly engine: "hush" | "loom";
  readonly value: string;
};

export type ProductOutputControls = {
  getHushMode(): ProductProcessOutputMode;
  getLoomMode(): ProductReadOutputMode;
  getHushState(): ProductEngineFrontendState;
  getLoomState(): ProductEngineFrontendState;
  setHushState(
    state: ProductEngineFrontendState | string,
  ): Result<ProductEngineFrontendState, ProductOutputControlError>;
  setLoomState(
    state: ProductEngineFrontendState | string,
  ): Result<ProductEngineFrontendState, ProductOutputControlError>;
};

export type ProductOutputControlsOptions = {
  readonly hush?: ProductProcessOutputMode;
  readonly loom?: ProductReadOutputMode;
};

function isFrontendState(value: string): value is ProductEngineFrontendState {
  return value === "on" || value === "off";
}

export function composeProductOutputControls(
  options: ProductOutputControlsOptions = {},
): ProductOutputControls {
  let hush = options.hush ?? "hush";
  let loom = options.loom ?? "loom";
  return {
    getHushMode: () => hush,
    getLoomMode: () => loom,
    getHushState: () => (hush === "raw" ? "off" : "on"),
    getLoomState: () => (loom === "raw" ? "off" : "on"),
    setHushState(state) {
      if (!isFrontendState(state)) {
        return err({ code: "unsupported-output-state", engine: "hush", value: String(state) });
      }
      hush = state === "off" ? "raw" : "hush";
      return ok(state);
    },
    setLoomState(state) {
      if (!isFrontendState(state)) {
        return err({ code: "unsupported-output-state", engine: "loom", value: String(state) });
      }
      loom = state === "off" ? "raw" : "loom";
      return ok(state);
    },
  };
}
