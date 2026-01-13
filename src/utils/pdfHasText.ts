import * as pdfjsLib from "pdfjs-dist";

export async function pdfHasEmbeddedText(file: File): Promise<boolean> {
  const buf = await file.arrayBuffer();

  const loadingTask = pdfjsLib.getDocument({ data: buf });
  const pdf = await loadingTask.promise;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const text = await page.getTextContent();

    if (text.items && text.items.length > 0) {
      return true; // embedded text layer exists
    }
  }

  return false; // image-only PDF
}
