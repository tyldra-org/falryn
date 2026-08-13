import { describe, expect, test } from "bun:test";

import {
  describeWorkspaceListingError,
  isHiddenLogical,
  listingLimits,
} from "./workspace-listing.ts";

describe("workspace listing helpers", () => {
  test("treats a dotted path segment as hidden", () => {
    expect(isHiddenLogical(".env")).toBe(true);
    expect(isHiddenLogical("src/.git/config")).toBe(true);
    expect(isHiddenLogical("src/a.ts")).toBe(false);
  });

  test("fills listing limits", () => {
    expect(listingLimits({ maxDepth: 2 }).maxDepth).toBe(2);
    expect(listingLimits({ maxDepth: 2 }).includeHidden).toBe(true);
  });

  test("describes every listing error code", () => {
    expect(describeWorkspaceListingError({ code: "escaped" })).toBe("escaped");
    expect(describeWorkspaceListingError({ code: "absolute-unscoped" })).toBe("absolute-unscoped");
    expect(describeWorkspaceListingError({ code: "symlink-escape" })).toBe("symlink-escape");
    expect(describeWorkspaceListingError({ code: "not-found" })).toBe("not-found");
    expect(describeWorkspaceListingError({ code: "not-a-directory" })).toBe("not-a-directory");
    expect(describeWorkspaceListingError({ code: "cancelled" })).toBe("cancelled");
    expect(describeWorkspaceListingError({ code: "filesystem", reason: "permission-denied" })).toBe(
      "filesystem:permission-denied",
    );
    expect(
      describeWorkspaceListingError({ code: "malformed", reason: "path-illegal-character" }),
    ).toBe("malformed:path-illegal-character");
  });
});
