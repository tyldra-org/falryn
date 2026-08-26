/** Deterministic large-evidence fixture shared by the Loom scorecard. */

export const LOOM_EVIDENCE_CORPUS_VERSION = "loom-large-evidence.v1";

export const LOOM_HEAD_FACT = "workspace=falryn generation=812";
export const LOOM_RANGE_FACT = "decision=bounded-reads preserve=exact-recovery";
export const LOOM_TAIL_FACT = "exit=0 digest=verified";

export type LoomLargeEvidenceFixture = {
  readonly source: string;
  readonly rangeOffset: number;
  readonly rangeLength: number;
  readonly headBytes: number;
  readonly tailBytes: number;
};

export function createLoomLargeEvidenceFixture(): LoomLargeEvidenceFixture {
  const lines = [`BEGIN ${LOOM_HEAD_FACT}`];
  for (let index = 0; index < 768; index += 1) {
    lines.push(
      `record=${String(index).padStart(4, "0")} lane=context status=stable owner=loom payload=abcdefghijklmnopqrstuvwxyz`,
    );
    if (index === 383) {
      lines.push(`TARGET ${LOOM_RANGE_FACT}`);
    }
  }
  lines.push(`END ${LOOM_TAIL_FACT}`);
  const source = `${lines.join("\n")}\n`;
  const rangeStart = source.indexOf(`TARGET ${LOOM_RANGE_FACT}`);
  const rangeEnd = source.indexOf("\n", rangeStart) + 1;
  return {
    source,
    rangeOffset: new TextEncoder().encode(source.slice(0, rangeStart)).byteLength,
    rangeLength: new TextEncoder().encode(source.slice(rangeStart, rangeEnd)).byteLength,
    headBytes: 96,
    tailBytes: 96,
  };
}
