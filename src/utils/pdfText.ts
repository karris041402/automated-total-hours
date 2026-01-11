import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy, TextItem } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker?url";

GlobalWorkerOptions.workerSrc = pdfWorker;

export type PdfSide = "left" | "right" | "full";

/**
 * Extract text directly from the PDF (no OCR).
 * Works when the Ricoh PDF has an embedded text layer (common for "scanned" PDFs with OCR enabled in the scanner).
 *
 * We also support selecting only the LEFT or RIGHT half of a page by filtering text items by their X position.
 */
export async function extractPdfText(file: File, side: PdfSide = "full") {
  const buf = await file.arrayBuffer();
  const pdf: PDFDocumentProxy = await getDocument({ data: buf }).promise;

  let out = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    const midX = viewport.width / 2;

    const content = await page.getTextContent();
    const items = content.items as TextItem[];

    // In pdf.js, item.transform[4] is X, [5] is Y (in viewport coords)
    const filtered = items.filter((it) => {
      const x = (it.transform as any)[4] as number;
      if (side === "left") return x < midX;
      if (side === "right") return x >= midX;
      return true;
    });

    // Keep a stable reading order: top-to-bottom, then left-to-right
    filtered.sort((a, b) => {
      const ay = (a.transform as any)[5] as number;
      const by = (b.transform as any)[5] as number;
      if (Math.abs(ay - by) > 2) return by - ay; // higher Y first (pdf coords)
      const ax = (a.transform as any)[4] as number;
      const bx = (b.transform as any)[4] as number;
      return ax - bx;
    });

    out += "\n" + filtered.map((i) => i.str).join(" ");
  }

  return out;
}
