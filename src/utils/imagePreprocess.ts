export async function preprocessImageUrl(
  url: string,
  scale = 1,
  threshold = 180
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const w = Math.floor(img.width * scale);
        const h = Math.floor(img.height * scale);
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas 2D not supported"));
        ctx.drawImage(img, 0, 0, w, h);

        // grayscale + threshold
        try {
          const imgData = ctx.getImageData(0, 0, w, h);
          const d = imgData.data;
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], g = d[i + 1], b = d[i + 2];
            const gray = r * 0.299 + g * 0.587 + b * 0.114;
            const v = gray > threshold ? 255 : 0;
            d[i] = d[i + 1] = d[i + 2] = v;
          }
          ctx.putImageData(imgData, 0, 0);
        } catch {
          // ignore
        }

        resolve(canvas.toDataURL("image/png"));
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error("Image load error"));
    img.src = url;
  });
}
