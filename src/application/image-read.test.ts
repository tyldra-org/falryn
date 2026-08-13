import { describe, expect, test } from "bun:test";

import { bindWorkspacePath, createInMemoryFileSystem, localPath } from "../domain/index.ts";
import { createImageReader } from "./image-read.ts";
import { createWorkspaceReader } from "./workspace-read.ts";

const root = localPath("/work/project");

function bytesForChunk(type: string, data: readonly number[]): number[] {
  return [
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
    ...type.split("").map((character) => character.charCodeAt(0)),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

function png(width: number, height: number, animated = false): Uint8Array {
  const header = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...bytesForChunk("IHDR", [
      (width >>> 24) & 0xff,
      (width >>> 16) & 0xff,
      (width >>> 8) & 0xff,
      width & 0xff,
      (height >>> 24) & 0xff,
      (height >>> 16) & 0xff,
      (height >>> 8) & 0xff,
      height & 0xff,
      8,
      6,
      0,
      0,
      0,
    ]),
    ...bytesForChunk("sRGB", [0]),
  ];
  if (animated) {
    header.push(...bytesForChunk("acTL", [0, 0, 0, 3, 0, 0, 0, 0]));
  }
  header.push(...bytesForChunk("IEND", []));
  return Uint8Array.from(header);
}

function jpeg(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0,
    17,
    8,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}

function gif(): Uint8Array {
  return Uint8Array.from([
    ...new TextEncoder().encode("GIF89a"),
    1,
    0,
    1,
    0,
    0,
    0,
    0,
    0x2c,
    0,
    0,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    2,
    1,
    0,
    0,
    0x3b,
  ]);
}

function imageReader(path: string, bytes: Uint8Array) {
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/work/project": { kind: "directory" },
      [`/work/project/${path}`]: { kind: "file", bytes },
    },
  });
  return createImageReader(createWorkspaceReader(fileSystem));
}

describe("image reader", () => {
  test("returns bounded metadata and an exact provider-compatible PNG projection", async () => {
    const source = png(2, 3);
    const result = await imageReader("photo.bin", source).read(root, { path: "photo.bin" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected image");
    }
    expect(result.value.document).toMatchObject({
      format: "png",
      mediaType: "image/png",
      width: 2,
      height: 3,
      colorProfile: "srgb",
      animated: false,
      frameCount: 1,
    });
    expect(result.value.document.digest).toMatch(/^sha-256:[0-9a-f]{64}$/);
    expect(result.value.visual?.bytes).toEqual(source);
    expect(result.value.visual?.providerCompatible).toBe(true);
    expect(result.value.status).toBe("complete");
  });

  test("detects JPEG and GIF metadata from bytes rather than extensions", async () => {
    const jpegResult = await imageReader("photo.txt", jpeg(20, 10)).read(root, {
      path: "photo.txt",
    });
    const gifResult = await imageReader("animation.data", gif()).read(root, {
      path: "animation.data",
    });

    expect(jpegResult.ok && jpegResult.value.document.format).toBe("jpeg");
    expect(jpegResult.ok && jpegResult.value.document.width).toBe(20);
    expect(gifResult.ok && gifResult.value.document.format).toBe("gif");
    expect(gifResult.ok && gifResult.value.document.frameCount).toBe(1);
  });

  test("keeps metadata when pixel or visual budgets prevent expansion", async () => {
    const source = png(100, 100);
    const pixelLimited = await imageReader("large.png", source).read(root, {
      path: "large.png",
      limits: { maxPixels: 10 },
    });
    const byteLimited = await imageReader("large.png", source).read(root, {
      path: "large.png",
      limits: { maxVisualBytes: 1 },
    });

    expect(pixelLimited.ok).toBe(true);
    expect(pixelLimited.ok && pixelLimited.value.visual).toBeNull();
    expect(pixelLimited.ok && pixelLimited.value.stopReason).toBe("decode-cost");
    expect(pixelLimited.ok && pixelLimited.value.diagnostics).toContainEqual({
      code: "decode-cost",
      byteOffset: null,
    });
    expect(byteLimited.ok && byteLimited.value.visual).toBeNull();
    expect(byteLimited.ok && byteLimited.value.stopReason).toBe("budget");
    expect(byteLimited.ok && byteLimited.value.diagnostics).toContainEqual({
      code: "huge-output",
      byteOffset: null,
    });
  });

  test("makes bounded header scanning visible when metadata chunks exceed the limit", async () => {
    const result = await imageReader("many-chunks.png", png(2, 2)).read(root, {
      path: "many-chunks.png",
      limits: { maxMetadataChunks: 1 },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.document.width).toBe(2);
    expect(result.ok && result.value.diagnostics).toContainEqual({
      code: "metadata-limit",
      byteOffset: expect.any(Number),
    });
    expect(result.ok && result.value.omissions).toContainEqual({
      kind: "metadata",
      count: 1,
      reason: "budget",
    });
  });

  test("labels animation pressure and unsafe SVG without executing it", async () => {
    const animated = await imageReader("animated.png", png(2, 2, true)).read(root, {
      path: "animated.png",
      limits: { maxFrames: 2 },
    });
    const unsafeSvg = new TextEncoder().encode(
      '<svg width="2" height="2"><script>alert("no")</script></svg>',
    );
    const svg = await imageReader("vector.svg", unsafeSvg).read(root, { path: "vector.svg" });

    expect(animated.ok && animated.value.document.animated).toBe(true);
    expect(animated.ok && animated.value.document.frameCount).toBe(3);
    expect(animated.ok && animated.value.omissions).toContainEqual({
      kind: "frames",
      count: 1,
      reason: "budget",
    });
    expect(svg.ok && svg.value.visual).toBeNull();
    expect(svg.ok && svg.value.diagnostics).toContainEqual({
      code: "unsafe-svg",
      byteOffset: 0,
    });
  });

  test("refuses malformed and unsupported formats without returning source bytes", async () => {
    const malformed = await imageReader(
      "bad.png",
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ).read(root, {
      path: "bad.png",
    });
    const tiff = await imageReader("photo.tif", Uint8Array.from([0x49, 0x49, 0x2a, 0])).read(root, {
      path: "photo.tif",
    });
    const text = await imageReader("note.txt", new TextEncoder().encode("not an image")).read(
      root,
      {
        path: "note.txt",
      },
    );

    expect(malformed).toEqual({
      ok: false,
      error: { code: "malformed-image", format: "png" },
    });
    expect(tiff).toEqual({
      ok: false,
      error: { code: "unsupported-format", mediaType: "image/tiff" },
    });
    expect(text).toEqual({ ok: false, error: { code: "not-image" } });
    expect(JSON.stringify(text)).not.toContain("not an image");
  });

  test("propagates cancellation before reading or after a source read", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await imageReader("photo.png", png(1, 1)).read(
      root,
      { path: "photo.png" },
      controller.signal,
    );

    expect(result).toEqual({ ok: false, error: { code: "cancelled" } });
  });

  test("binds the source through the workspace boundary", async () => {
    const source = png(1, 1);
    const fileSystem = createInMemoryFileSystem({
      nodes: {
        "/work/project": { kind: "directory" },
        "/work/project/photo.png": { kind: "file", bytes: source },
      },
    });
    const workspace = createWorkspaceReader(fileSystem);
    const bound = bindWorkspacePath(root, "photo.png");
    expect(bound.ok).toBe(true);
    const result = await createImageReader(workspace).read(root, { path: "photo.png" });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.document.bound.logical).toBe("photo.png");
  });
});
