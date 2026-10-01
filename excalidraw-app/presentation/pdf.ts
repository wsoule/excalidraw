/**
 * Minimal PDF writer: one JPEG image per page, each page sized to the image's
 * aspect ratio. Dependency-free so it works offline and on iPad Safari.
 */

export type PdfImagePage = {
  /** baseline JPEG bytes (as produced by `canvas.toBlob("image/jpeg")`) */
  jpeg: Uint8Array;
  /** image size in pixels */
  imageWidth: number;
  imageHeight: number;
  /** page size in PDF points (1/72 inch) */
  pageWidth: number;
  pageHeight: number;
};

const toPdfNumber = (value: number) =>
  Number.isInteger(value) ? `${value}` : value.toFixed(2);

/** UTF-16BE hex string, so non-ASCII titles survive */
const toPdfTextString = (text: string) => {
  let hex = "FEFF";
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
};

export const createImagePdf = (
  pages: readonly PdfImagePage[],
  opts: { title?: string } = {},
): Blob => {
  if (!pages.length) {
    throw new Error("cannot create a PDF without pages");
  }

  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  /** byte offset of each object, indexed by object number */
  const offsets: number[] = [];
  let byteLength = 0;

  const write = (data: string | Uint8Array) => {
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    chunks.push(bytes);
    byteLength += bytes.length;
  };

  const beginObject = (num: number) => {
    offsets[num] = byteLength;
    write(`${num} 0 obj\n`);
  };

  // object layout: 1 catalog, 2 page tree, 3 info, then 3 objects per page
  const CATALOG = 1;
  const PAGES = 2;
  const INFO = 3;
  const pageObj = (index: number) => 4 + index * 3;
  const contentObj = (index: number) => 5 + index * 3;
  const imageObj = (index: number) => 6 + index * 3;
  const objectCount = 4 + pages.length * 3;

  write("%PDF-1.4\n");
  // binary marker comment, so transfer tools treat the file as binary
  write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  beginObject(CATALOG);
  write(`<< /Type /Catalog /Pages ${PAGES} 0 R >>\nendobj\n`);

  beginObject(PAGES);
  write(
    `<< /Type /Pages /Kids [${pages
      .map((_, index) => `${pageObj(index)} 0 R`)
      .join(" ")}] /Count ${pages.length} >>\nendobj\n`,
  );

  beginObject(INFO);
  write(
    `<< ${
      opts.title ? `/Title ${toPdfTextString(opts.title)} ` : ""
    }/Producer (Excalidraw) >>\nendobj\n`,
  );

  pages.forEach((page, index) => {
    const width = toPdfNumber(page.pageWidth);
    const height = toPdfNumber(page.pageHeight);

    beginObject(pageObj(index));
    write(
      `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /XObject << /Im0 ${imageObj(index)} 0 R >> >> ` +
        `/Contents ${contentObj(index)} 0 R >>\nendobj\n`,
    );

    const content = encoder.encode(
      `q\n${width} 0 0 ${height} 0 0 cm\n/Im0 Do\nQ\n`,
    );
    beginObject(contentObj(index));
    write(`<< /Length ${content.length} >>\nstream\n`);
    write(content);
    write("\nendstream\nendobj\n");

    beginObject(imageObj(index));
    write(
      `<< /Type /XObject /Subtype /Image /Width ${page.imageWidth} ` +
        `/Height ${page.imageHeight} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
    );
    write(page.jpeg);
    write("\nendstream\nendobj\n");
  });

  const xrefOffset = byteLength;
  // every xref entry must be exactly 20 bytes long
  let xref = `xref\n0 ${objectCount}\n0000000000 65535 f \n`;
  for (let num = 1; num < objectCount; num++) {
    xref += `${String(offsets[num]).padStart(10, "0")} 00000 n \n`;
  }
  write(xref);
  write(
    `trailer\n<< /Size ${objectCount} /Root ${CATALOG} 0 R /Info ${INFO} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  );

  return new Blob(chunks as BlobPart[], { type: "application/pdf" });
};
