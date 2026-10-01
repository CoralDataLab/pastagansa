import { BadRequestException } from "@nestjs/common";

// Bound decoded image size before handing untrusted images to Tesseract.
export function validateOcrDimensions(content: Buffer, mediaType: string) {
  let width = 0, height = 0;
  if (mediaType === "image/png" && content.length >= 24 && content.toString("ascii", 12, 16) === "IHDR") {
    width = content.readUInt32BE(16); height = content.readUInt32BE(20);
  } else if (mediaType === "image/jpeg") {
    let offset = 2;
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 4 <= content.length) {
      if (content[offset++] !== 0xff) break;
      while (content[offset] === 0xff) offset++;
      if (offset >= content.length) break;
      const marker = content[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      if (offset + 2 > content.length) break;
      const size = content.readUInt16BE(offset);
      if (size < 2 || offset + size > content.length) break;
      if (frames.has(marker) && size >= 8) {
        height = content.readUInt16BE(offset + 3); width = content.readUInt16BE(offset + 5); break;
      }
      offset += size;
    }
  }
  if (!width || !height)
    throw new BadRequestException("The image header is invalid or unsupported");
  if (width > 8000 || height > 8000 || width * height > 20_000_000)
    throw new BadRequestException("Local OCR supports images up to 8000 pixels per side and 20 megapixels");
}
