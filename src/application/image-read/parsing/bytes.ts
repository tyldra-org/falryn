/** Bounds-checked byte decoding primitives for image headers. */

export function byteAt(bytes: Uint8Array, offset: number): number | null {
  const value = bytes[offset];
  return value === undefined ? null : value;
}

export function uint16BE(bytes: Uint8Array, offset: number): number | null {
  const high = byteAt(bytes, offset);
  const low = byteAt(bytes, offset + 1);
  return high === null || low === null ? null : (high << 8) | low;
}

export function uint16LE(bytes: Uint8Array, offset: number): number | null {
  const low = byteAt(bytes, offset);
  const high = byteAt(bytes, offset + 1);
  return low === null || high === null ? null : low | (high << 8);
}

export function uint24LE(bytes: Uint8Array, offset: number): number | null {
  const first = byteAt(bytes, offset);
  const second = byteAt(bytes, offset + 1);
  const third = byteAt(bytes, offset + 2);
  return first === null || second === null || third === null
    ? null
    : first | (second << 8) | (third << 16);
}

export function uint32BE(bytes: Uint8Array, offset: number): number | null {
  const first = byteAt(bytes, offset);
  const second = byteAt(bytes, offset + 1);
  const third = byteAt(bytes, offset + 2);
  const fourth = byteAt(bytes, offset + 3);
  return first === null || second === null || third === null || fourth === null
    ? null
    : first * 0x1000000 + (second << 16) + (third << 8) + fourth;
}

export function uint32LE(bytes: Uint8Array, offset: number): number | null {
  const first = byteAt(bytes, offset);
  const second = byteAt(bytes, offset + 1);
  const third = byteAt(bytes, offset + 2);
  const fourth = byteAt(bytes, offset + 3);
  return first === null || second === null || third === null || fourth === null
    ? null
    : first + (second << 8) + (third << 16) + fourth * 0x1000000;
}

export function int32LE(bytes: Uint8Array, offset: number): number | null {
  const value = uint32LE(bytes, offset);
  return value === null ? null : value > 0x7fffffff ? value - 0x100000000 : value;
}

export function text(bytes: Uint8Array, offset: number, length: number): string | null {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    return null;
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

export function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => byteAt(bytes, offset + index) === value);
}
