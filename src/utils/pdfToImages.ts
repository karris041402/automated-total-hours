import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker?url";

GlobalWorkerOptions.workerSrc = pdfWorker;

export async function pdfToPngDataUrls(file: File, scale = 2.2) {
  const buf = await file.arrayBuffer();
  const pdf: PDFDocumentProxy = await getDocument({ data: buf }).promise;

  const pages: string[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    // render full page first
    const fullCanvas = document.createElement("canvas");
    const fullCtx = fullCanvas.getContext("2d");
    if (!fullCtx) throw new Error("Canvas 2D not supported");

    fullCanvas.width = Math.floor(viewport.width);
    fullCanvas.height = Math.floor(viewport.height);

    await page.render({
      canvasContext: fullCtx,
      viewport,
      canvas: fullCanvas,
    } as any).promise;

    // 🔒 FORCE LEFT HALF ALWAYS (Ricoh-safe)
    const halfW = Math.floor(fullCanvas.width / 2);

    const crop = document.createElement("canvas");
    const cctx = crop.getContext("2d");
    if (!cctx) throw new Error("Canvas 2D not supported");

    crop.width = halfW;
    crop.height = fullCanvas.height;

    cctx.drawImage(
      fullCanvas,
      0,
      0,
      halfW,
      fullCanvas.height, // SOURCE: LEFT HALF
      0,
      0,
      halfW,
      fullCanvas.height // DEST
    );

    const outCanvas = crop;

    // --- simple OCR preprocessing: grayscale + threshold ---
    try {
      const ctx = outCanvas.getContext("2d");
      if (ctx) {
        const imgData = ctx.getImageData(
          0,
          0,
          outCanvas.width,
          outCanvas.height
        );
        const d = imgData.data;

        for (let i = 0; i < d.length; i += 4) {
          const r = d[i],
            g = d[i + 1],
            b = d[i + 2];
          // grayscale
          const gray = r * 0.299 + g * 0.587 + b * 0.114;
          // threshold (tweakable)
          const v = gray > 180 ? 255 : 0;
          d[i] = d[i + 1] = d[i + 2] = v;
          // keep alpha
        }

        ctx.putImageData(imgData, 0, 0);
      }
    } catch {
      // ignore preprocessing failures
    }

    pages.push(outCanvas.toDataURL("image/png"));
  }

  return pages;
}
