import { Injectable } from "@nestjs/common";
import PDFDocument = require("pdfkit");
import {
  issuerAddressLines,
  issuerContactLines,
  issuerDisplayName,
  issuerLegalName,
  issuerUnipersonalMention,
  issuerPrimaryColor,
  readIssuerSnapshot,
  truncatePdfText,
  type IssuerSnapshot,
} from "../documents/issuer-snapshot";

interface DecimalValue {
  toString(): string;
}

export interface QuotePdfInput {
  issuerLogoMediaType: string | null;
  issuerLogoContent: Uint8Array | null;
  quote: {
    code: string;
    status: string;
    issueDate: Date;
    validUntil: Date | null;
    currency: string;
    customerLegalName: string;
    customerTaxId: string | null;
    billingAddress: unknown;
    notes: string | null;
    issuerSnapshot: unknown;
    subtotal: DecimalValue;
    discountTotal: DecimalValue;
    taxTotal: DecimalValue;
    total: DecimalValue;
    lines: Array<{
      position: number;
      description: string;
      quantity: DecimalValue;
      unitPrice: DecimalValue;
      discountPct: DecimalValue;
      taxRate: DecimalValue;
      totalAmount: DecimalValue;
    }>;
  };
}

const PAGE = {
  left: 48,
  right: 547,
  top: 48,
  contentBottom: 742,
  footerY: 774,
};
const COLOR = {
  ink: "#10233F",
  muted: "#52627A",
  primary: "#F71950",
  primarySoft: "#FDECF1",
  line: "#D9DEE7",
  paper: "#FFFFFF",
};

@Injectable()
export class QuotePdfService {
  async render(input: QuotePdfInput): Promise<Buffer> {
    const { quote } = input;
    const issuer = readIssuerSnapshot(quote.issuerSnapshot);
    const document = new PDFDocument({
      size: "A4",
      margins: { top: PAGE.top, right: 48, bottom: 48, left: PAGE.left },
      bufferPages: true,
      info: {
        Title: `Presupuesto ${quote.code}`,
        Author: issuerLegalName(issuer),
        Subject: `Presupuesto para ${quote.customerLegalName}`,
        Creator: "Pastagansa",
      },
    });
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      document.on("data", (chunk: Buffer) => chunks.push(chunk));
      document.on("end", () => resolve(Buffer.concat(chunks)));
      document.on("error", reject);
    });

    this.drawDocumentHeader(document, input, issuer);
    this.drawCustomer(document, input, issuer);
    let rowY = this.drawTableHeader(document, document.y + 24);
    for (const line of quote.lines) {
      const rowHeight = Math.max(
        28,
        document.heightOfString(line.description, { width: 198 }) + 12,
      );
      if (rowY + rowHeight > PAGE.contentBottom) {
        document.addPage();
        this.drawContinuationHeader(document, quote.code);
        rowY = this.drawTableHeader(document, document.y + 16);
      }
      this.drawLine(document, line, quote.currency, rowY, rowHeight);
      rowY += rowHeight;
    }
    document.y = rowY + 20;
    this.ensureSpace(document, 150, quote.code);
    this.drawTotals(document, input, issuer);
    this.drawNotesAndTerms(document, input, issuer);
    this.drawFooters(document, input, issuer);
    document.end();
    return completed;
  }

  private drawDocumentHeader(
    document: PDFKit.PDFDocument,
    input: QuotePdfInput,
    issuer: IssuerSnapshot,
  ) {
    const { quote } = input;
    const primary = issuerPrimaryColor(issuer);
    const hasLogo = Boolean(input.issuerLogoContent && issuer.logo);
    if (hasLogo)
      document.image(Buffer.from(input.issuerLogoContent!), PAGE.left, PAGE.top, {
        fit: [78, 30],
        valign: "center",
      });
    else {
      document.circle(PAGE.left + 13, PAGE.top + 13, 11).fill(primary);
      document.circle(PAGE.left + 15, PAGE.top + 10, 3).fill(COLOR.paper);
    }
    document
      .font("Helvetica-Bold")
      .fontSize(19)
      .fillColor(COLOR.ink)
      .text(issuerDisplayName(issuer).toUpperCase(), PAGE.left + (hasLogo ? 88 : 34), PAGE.top + 5, {
        width: hasLogo ? 246 : 300,
      });
    document
      .roundedRect(407, PAGE.top, 140, 30, 5)
      .fill(COLOR.primarySoft);
    document
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor(primary)
      .text("PRESUPUESTO", 407, PAGE.top + 9, {
        width: 140,
        align: "center",
      });
    document.y = 106;
  }

  private drawCustomer(
    document: PDFKit.PDFDocument,
    input: QuotePdfInput,
    issuer: IssuerSnapshot,
  ) {
    const { quote } = input;
    const primary = issuerPrimaryColor(issuer);
    const top = document.y;
    document
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(primary)
      .text("Datos del emisor", PAGE.left, top);
    document
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(COLOR.ink)
      .text(issuerLegalName(issuer), PAGE.left, top + 19, { width: 275 });
    const issuerDetails = [
      issuer.taxId ? `NIF: ${issuer.taxId}` : null,
      issuerUnipersonalMention(issuer),
      ...issuerAddressLines(issuer),
      ...issuerContactLines(issuer),
    ].filter((value): value is string => Boolean(value));
    document
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(COLOR.muted)
      .text(issuerDetails.join("\n") || "Datos fiscales no disponibles", PAGE.left, top + 35, {
        width: 275,
        lineGap: 2,
      });
    const rows = [
      ["Nº de presupuesto", quote.code],
      ["Fecha de emisión", formatDate(quote.issueDate)],
      ["Válido hasta", quote.validUntil ? formatDate(quote.validUntil) : "-"],
    ];
    rows.forEach(([label, value], index) => {
      const y = top + index * 20;
      document
        .font("Helvetica")
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(label, 364, y, { width: 105 });
      document.text(value, 469, y, { width: 78, align: "right" });
    });
    const customerTop = Math.max(
      top + 91,
      top +
        42 +
        document.heightOfString(issuerDetails.join("\n"), {
          width: 275,
          lineGap: 2,
        }) +
        12,
    );
    document
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(primary)
      .text("Datos del cliente", PAGE.left, customerTop);
    document
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(COLOR.ink)
      .text(quote.customerLegalName, PAGE.left, customerTop + 19, {
        width: 300,
      });
    const customerDetails = [
      quote.customerTaxId ? `NIF: ${quote.customerTaxId}` : null,
      ...billingAddressLines(quote.billingAddress),
    ].filter((value): value is string => Boolean(value));
    document
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(COLOR.muted)
      .text(
        customerDetails.join("\n") || "Sin dirección de facturación",
        PAGE.left,
        customerTop + 36,
        {
          width: 330,
          lineGap: 2,
        },
      );
    document.y =
      customerTop +
      36 +
      document.heightOfString(
        customerDetails.join("\n") || "Sin dirección de facturación",
        { width: 330, lineGap: 2 },
      ) +
      12;
  }

  private drawContinuationHeader(document: PDFKit.PDFDocument, code: string) {
    document
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(COLOR.ink)
      .text(`Presupuesto ${code} - continuación`, PAGE.left, PAGE.top, {
        width: PAGE.right - PAGE.left,
      });
    document.y = 70;
  }

  private drawTableHeader(document: PDFKit.PDFDocument, y: number) {
    document
      .roundedRect(PAGE.left, y, PAGE.right - PAGE.left, 28, 5)
      .fill(COLOR.primarySoft);
    const headings = [
      ["Descripción", 58, 190, "left"],
      ["Cant.", 258, 45, "right"],
      ["Precio", 313, 60, "right"],
      ["Dto.", 383, 45, "right"],
      ["IVA", 438, 35, "right"],
      ["Total", 483, 54, "right"],
    ] as const;
    document.font("Helvetica-Bold").fontSize(7.5).fillColor(COLOR.ink);
    for (const [label, x, width, align] of headings)
      document.text(label.toUpperCase(), x, y + 10, { width, align });
    return y + 28;
  }

  private drawLine(
    document: PDFKit.PDFDocument,
    line: QuotePdfInput["quote"]["lines"][number],
    currency: string,
    y: number,
    height: number,
  ) {
    document
      .moveTo(PAGE.left, y + height)
      .lineTo(PAGE.right, y + height)
      .strokeColor(COLOR.line)
      .lineWidth(0.5)
      .stroke();
    const cells = [
      [line.description, 58, 190, "left"],
      [formatDecimal(line.quantity, 3), 258, 45, "right"],
      [formatMoney(line.unitPrice, currency), 313, 60, "right"],
      [`${formatDecimal(line.discountPct, 2)}%`, 383, 45, "right"],
      [`${formatDecimal(line.taxRate, 2)}%`, 438, 35, "right"],
      [formatMoney(line.totalAmount, currency), 483, 54, "right"],
    ] as const;
    document.font("Helvetica").fontSize(7.5).fillColor(COLOR.ink);
    for (const [value, x, width, align] of cells)
      document.text(value, x, y + 7, { width, align, lineGap: 1 });
  }

  private drawTotals(
    document: PDFKit.PDFDocument,
    input: QuotePdfInput,
    issuer: IssuerSnapshot,
  ) {
    const { quote } = input;
    const x = 345;
    const width = PAGE.right - x;
    const rows = [
      ["Base", formatMoney(quote.subtotal, quote.currency)],
      ["Descuentos", formatDiscountMoney(quote.discountTotal, quote.currency)],
      ["Impuestos", formatMoney(quote.taxTotal, quote.currency)],
    ];
    let y = document.y;
    document.fontSize(9);
    for (const [label, value] of rows) {
      document.font("Helvetica").fillColor(COLOR.ink).text(label, x, y, {
        width: 85,
      });
      document
        .font("Helvetica")
        .fillColor(COLOR.ink)
        .text(value, x + 85, y, {
          width: width - 85,
          align: "right",
        });
      y += 20;
    }
    document
      .roundedRect(x - 10, y + 3, PAGE.right - x + 10, 34, 5)
      .fill(COLOR.primarySoft);
    document
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(issuerPrimaryColor(issuer))
      .text("Total", x, y + 14, { width: 85 });
    document
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(issuerPrimaryColor(issuer))
      .text(formatMoney(quote.total, quote.currency), x + 85, y + 14, {
        width: width - 85,
        align: "right",
      });
    document.y = y + 48;
  }

  private drawNotesAndTerms(
    document: PDFKit.PDFDocument,
    input: QuotePdfInput,
    issuer: IssuerSnapshot,
  ) {
    const { quote } = input;
    const primary = issuerPrimaryColor(issuer);
    const notes =
      truncatePdfText([quote.notes, issuer.defaultNotes].filter(Boolean).join("\n")) ||
      "Sin notas adicionales.";
    const terms = truncatePdfText([
      issuer.paymentInstructions,
      issuer.bankIban ? `IBAN: ${issuer.bankIban}` : null,
      issuer.paymentTerms,
      quote.validUntil
        ? `Oferta válida hasta el ${formatDate(quote.validUntil)}.`
        : "Validez no especificada.",
      `Moneda: ${quote.currency}`,
    ]
      .filter(Boolean)
      .join("\n"));
    const contentHeight = Math.max(
      90,
      document.heightOfString(notes, { width: 230, lineGap: 2 }) + 52,
      document.heightOfString(terms, { width: 229, lineGap: 2 }) + 52,
    );
    this.ensureSpace(document, contentHeight + 28, quote.code);
    const top = document.y + 18;
    document
      .moveTo(PAGE.left, top)
      .lineTo(PAGE.right, top)
      .strokeColor(primary)
      .lineWidth(1)
      .stroke();
    document
      .moveTo(300, top + 20)
      .lineTo(300, top + contentHeight)
      .strokeColor("#F68AA5")
      .lineWidth(0.7)
      .stroke();
    document
      .font("Helvetica-Bold")
      .fontSize(10)
      .fillColor(primary)
      .text("NOTAS", PAGE.left, top + 22)
      .text("CONDICIONES DE PAGO", 318, top + 22);
    document
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(COLOR.muted)
      .text(notes, PAGE.left, top + 42, {
        width: 230,
        lineGap: 2,
      })
      .text(
        terms,
        318,
        top + 42,
        { width: 229, lineGap: 2 },
      );
    document.y = top + contentHeight + 6;
  }

  private ensureSpace(
    document: PDFKit.PDFDocument,
    requiredHeight: number,
    code: string,
  ) {
    if (document.y + requiredHeight <= PAGE.contentBottom) return;
    document.addPage();
    this.drawContinuationHeader(document, code);
  }

  private drawFooters(
    document: PDFKit.PDFDocument,
    input: QuotePdfInput,
    issuer: IssuerSnapshot,
  ) {
    const { quote } = input;
    const range = document.bufferedPageRange();
    for (
      let index = range.start;
      index < range.start + range.count;
      index += 1
    ) {
      document.switchToPage(index);
      document
        .moveTo(PAGE.left, PAGE.footerY - 8)
        .lineTo(PAGE.right, PAGE.footerY - 8)
        .strokeColor(COLOR.line)
        .lineWidth(0.5)
        .stroke();
      document
        .font("Helvetica")
        .fontSize(7.5)
        .fillColor(COLOR.muted)
        .text(
          truncatePdfText(
            issuer.documentFooter ||
              `${issuerLegalName(issuer)}${issuer.taxId ? ` | NIF: ${issuer.taxId}` : ""}`,
            110,
          ),
          PAGE.left,
          PAGE.footerY,
          { width: 300, lineBreak: false },
        );
      document.text(
        `Pastagansa · ${quote.code} · Página ${index + 1} de ${range.count}`,
        307,
        PAGE.footerY,
        {
          width: 240,
          align: "right",
          lineBreak: false,
        },
      );
    }
  }
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

function formatDecimal(value: DecimalValue, maximumFractionDigits: number) {
  return new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(Number(value.toString()));
}

function formatMoney(value: DecimalValue, currency: string) {
  return `${new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value.toString()))} ${currency}`;
}

function formatDiscountMoney(value: DecimalValue, currency: string) {
  const formatted = formatMoney(value, currency);
  return Number(value.toString()) === 0 ? formatted : `-${formatted}`;
}

function billingAddressLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const address = value as Record<string, unknown>;
  const string = (field: string) =>
    typeof address[field] === "string" && address[field]
      ? String(address[field])
      : null;
  return [
    string("line1"),
    string("line2"),
    [string("postalCode"), string("city")].filter(Boolean).join(" ") || null,
    [string("province"), string("country")].filter(Boolean).join(" · ") || null,
  ].filter((line): line is string => Boolean(line));
}
