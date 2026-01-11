import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker?url";

GlobalWorkerOptions.workerSrc = pdfWorker;

type Side = "left" | "right" | "full";

export async function pdfToPngDataUrls(file: File, scale = 2.2, side: Side = "full") {
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

    await page
      .render({
        canvasContext: fullCtx,
        viewport,
        canvas: fullCanvas,
      } as any)
      .promise;

    // crop to selected side
    let outCanvas = fullCanvas;

    if (side !== "full") {
      const halfW = Math.floor(fullCanvas.width / 2);
      const x = side === "left" ? 0 : halfW;

      const crop = document.createElement("canvas");
      const cctx = crop.getContext("2d");
      if (!cctx) throw new Error("Canvas 2D not supported");

      crop.width = halfW;
      crop.height = fullCanvas.height;

      cctx.drawImage(
        fullCanvas,
        x, 0, halfW, fullCanvas.height, // source rect
        0, 0, halfW, fullCanvas.height  // destination rect
      );

      outCanvas = crop;
    }

    pages.push(outCanvas.toDataURL("image/png"));
  }

  return pages;
}
