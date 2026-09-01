/** Pinned Headroom result for the deterministic Loom large-evidence fixture. */

export const HEADROOM_LOOM_BASELINE = {
  package: "headroom-ai",
  version: "0.36.5",
  contentType: "text",
  configuration: {
    useMagika: false,
    useKompress: false,
    useEntropyPreservation: false,
    compressionRatioTarget: 0.3,
    ccrEnabled: true,
  },
  sourceSha256: "17ee3bf50c205baa9bce92e59fe2a1cd04bf2d4f3ed5c3b039721d05aae72b3f",
  sourceBytes: 65_399,
  compressedSha256: "40a784ed8f73ee94dcbbdcaa94fbfc4ef45eacfe48550a09074e3c0471a9c620",
  compressedBytes: 19_638,
  estimatedTokensBefore: 16_349,
  estimatedTokensAfter: 4_909,
  ccrKeyBytes: 24,
  ccrKeyPresent: true,
  requiredFacts: {
    head: true,
    range: false,
    tail: true,
  },
  generator: "uvx --python 3.13 --from headroom-ai==0.36.5 UniversalCompressor(ContentType.TEXT)",
} as const;
