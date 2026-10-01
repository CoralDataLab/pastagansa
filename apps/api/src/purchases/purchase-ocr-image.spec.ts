import { validateOcrDimensions } from "./purchase-ocr-image";

describe("OCR decoded image bounds", () => {
  it("accepts a JPEG SOF header within bounds", () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xc0, 0x00, 0x08, 8, 0x03, 0x20, 0x04, 0xb0, 1]);
    expect(() => validateOcrDimensions(jpeg, "image/jpeg")).not.toThrow();
  });
  it("rejects truncated or malformed image headers", () => {
    for (const type of ["image/png", "image/jpeg"])
      expect(() => validateOcrDimensions(Buffer.from([0xff, 0xd8, 0xff]), type)).toThrow("header");
  });
  it("rejects excessive megapixels even when each side is within bounds", () => {
    const png = Buffer.alloc(24); png.write("IHDR", 12); png.writeUInt32BE(5000, 16); png.writeUInt32BE(5000, 20);
    expect(() => validateOcrDimensions(png, "image/png")).toThrow("megapixels");
  });
});
