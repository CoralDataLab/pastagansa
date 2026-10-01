import { BadRequestException } from "@nestjs/common";
import {
  proposalDocumentEvidence,
  validateProposalDocument,
} from "./purchase-proposal-documents.service";

const tinyPng = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000",
  "hex",
);

describe("purchase proposal documents", () => {
  it("builds command evidence from custodied document metadata", () => {
    expect(
      proposalDocumentEvidence([
        { id: "doc-1", sha256: "a".repeat(64), originalName: "invoice.pdf" },
      ]),
    ).toEqual([
      {
        reference: "purchase-proposal-document:doc-1",
        sha256: "a".repeat(64),
        description: "invoice.pdf",
      },
    ]);
    expect(proposalDocumentEvidence()).toEqual([]);
  });

  it("validates actual content type instead of trusting the upload metadata", () => {
    expect(() =>
      validateProposalDocument({
        buffer: tinyPng,
        originalname: "../factura.png",
        mimetype: "image/png",
        size: tinyPng.length,
      }),
    ).not.toThrow();
    expect(() =>
      validateProposalDocument({
        buffer: tinyPng,
        originalname: "factura.pdf",
        mimetype: "application/pdf",
        size: tinyPng.length,
      }),
    ).toThrow(BadRequestException);
  });
});
