/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type { CompactDocumentReader } from "./compact-document-read.ts";
export { createCompactDocumentReader } from "./compact-document-read.ts";
export type { ImageReader } from "./image-read.ts";
export { createImageReader } from "./image-read.ts";
export type { NotebookReader } from "./notebook-read.ts";
export { createNotebookReader } from "./notebook-read.ts";
export type { PdfReader } from "./pdf-read.ts";
export { createPdfReader } from "./pdf-read.ts";
export type { VirtualResourceReader } from "./virtual-resource-read.ts";
export { createVirtualResourceReader } from "./virtual-resource-read.ts";
