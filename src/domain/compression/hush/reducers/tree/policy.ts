/** Hush policy for tree entries that obscure useful workspace structure. */

const TREE_NOISE_NAMES = new Set([
  "node_modules",
  ".git",
  "target",
  "__pycache__",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".vercel",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  "coverage",
  ".nyc_output",
  ".DS_Store",
  "Thumbs.db",
  ".idea",
  ".vscode",
  ".vs",
  ".eggs",
]);

export function shouldPruneDefaultTreeNoise(tokens: readonly string[]): boolean {
  const args = tokens.slice(1);
  const showAll = args.some((arg) => arg === "-a" || arg === "--all");
  const hasIgnore = args.some((arg) => arg === "-I" || arg.startsWith("--ignore="));
  return !showAll && !hasIgnore;
}

export function isTreeNoiseName(name: string): boolean {
  return TREE_NOISE_NAMES.has(name) || name.endsWith(".egg-info");
}
