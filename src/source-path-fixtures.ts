/**
 * Convert Bun's host-native glob result into the repository-relative form that
 * source-boundary controls use in their ownership allowlists.
 */
export function sourcePathFromGlob(entry: string): string {
  return entry.replaceAll("\\", "/");
}
