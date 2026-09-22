import { Injectable } from "@nestjs/common";
import PDFDocument = require("pdfkit");
import { vatRecoveryDescription } from "./vat-recovery-description";
import {
  aeatQrPng,
  aeatQrUrl,
  type AeatQrEnvironment,
  type AeatQrMode,
} from "../sif/aeat-qr";
import {
  issuerAddressLines,
  issuerContactLines,
  issuerDisplayName,
  issuerLegalName,
  issuerPrimaryColor,
  readIssuerSnapshot,
  truncatePdfText,
  type IssuerSnapshot,
} from "../documents/issuer-snapshot";

interface DecimalValue {
  toString(): string;
}

export interface InvoicePdfInput {
  fullNumber: string;
  status: string;
  documentType?: string;
  sifInvoiceType?: string;
  rectificationKind?: string | null;
  rectificationImpact?: string | null;
  rectificationReason?: string | null;
  originalInvoice?: { id: string; fullNumber: string | null; issueDate?: Date; operationDate?: Date | null } | null;
  issuerLegalName: string;
  issuerTaxId: string;
  issuerSnapshot: unknown;
  issuerLogoMediaType: string | null;
  issuerLogoContent: Uint8Array | null;
  sifQr?: {
    mode: AeatQrMode;
    environment: AeatQrEnvironment;
  };
  customerLegalName: string;
  customerTaxId: string | null;
  billingAddress: unknown;
  issueDate: Date;
  operationDate?: Date | null;
  dueDate: Date | null;
  currency: string;
  notes: string | null;
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
}

const PAGE = { left: 48, right: 547, top: 48, bottom: 742, footer: 774 };
const COLOR = {
  ink: "#10233F",
  muted: "#52627A",
  primary: "#F71950",
  soft: "#FDECF1",
  line: "#D9DEE7",
  white: "#FFFFFF",
};

@Injectable()
export class InvoicePdfService {
  async render(invoice: InvoicePdfInput, options?: { compress?: boolean }): Promise<Buffer> {
    const isRectification = invoice.documentType === "CREDIT_NOTE";
    const issuer = readIssuerSnapshot(invoice.issuerSnapshot, {
      legalName: invoice.issuerLegalName,
      taxId: invoice.issuerTaxId,
    });
    const document = new PDFDocument({
      size: "A4",
      compress: options?.compress,
      margins: { top: PAGE.top, right: 48, bottom: 48, left: PAGE.left },
      bufferPages: true,
      info: {
        Title: `${isRectification ? "Factura rectificativa" : "Factura"} ${invoice.fullNumber}`,
        Author: issuerLegalName(issuer),
        Subject: `Factura para ${invoice.customerLegalName}`,
        Creator: "Pastagansa",
      },
    });
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      document.on("data", (chunk: Buffer) => chunks.push(chunk));
      document.on("end", () => resolve(Buffer.concat(chunks)));
      document.on("error", reject);
    });

    const qr = invoice.sifQr
      ? await aeatQrPng(
          aeatQrUrl({
            issuerTaxId: invoice.issuerTaxId,
            invoiceNumber: invoice.fullNumber,
            issueDate: invoice.issueDate,
            total: invoice.total.toString(),
            ...invoice.sifQr,
          }),
        )
      : undefined;
    this.header(document, invoice, issuer, qr);
    this.parties(document, invoice, issuer);
    if (isRectification) this.rectification(document, invoice);
    if (isVatRecovery(invoice)) {
      this.vatRecoveryAdjustment(document, invoice);
    } else {
      let y = this.tableHeader(document, document.y + 22);
      for (const line of invoice.lines) {
        const height = Math.max(
          28,
          document.heightOfString(line.description, { width: 190 }) + 12,
        );
        if (y + height > PAGE.bottom) {
          document.addPage();
          this.continuation(document, invoice.fullNumber);
          y = this.tableHeader(document, document.y + 16);
        }
        this.line(document, line, invoice.currency, y, height);
        y += height;
      }
      document.y = y + 20;
    }
    this.ensureSpace(document, 145, invoice.fullNumber);
    this.totals(document, invoice);
    this.notesAndTerms(document, invoice, issuer);
    this.footers(document, invoice, issuer);
    document.end();
    return completed;
  }

  private header(
    document: PDFKit.PDFDocument,
    invoice: InvoicePdfInput,
    issuer: IssuerSnapshot,
    qr?: Buffer,
  ) {
    const title =
      invoice.documentType === "CREDIT_NOTE"
        ? "FACTURA RECTIFICATIVA"
        : "FACTURA";
    const primary = issuerPrimaryColor(issuer);
    const hasLogo = Boolean(invoice.issuerLogoContent && issuer.logo);
    if (hasLogo)
      document.image(Buffer.from(invoice.issuerLogoContent!), PAGE.left, PAGE.top, {
        fit: [78, 30],
        valign: "center",
      });
    else {
      document.circle(PAGE.left + 13, PAGE.top + 13, 11).fill(primary);
      document.circle(PAGE.left + 15, PAGE.top + 10, 3).fill(COLOR.white);
    }
    document
      .font("Helvetica-Bold")
      .fontSize(19)
      .fillColor(COLOR.ink)
      .text(issuerDisplayName(issuer).toUpperCase(), PAGE.left + (hasLogo ? 88 : 34), PAGE.top + 5, {
        width: hasLogo ? 246 : 300,
      });
    document
      .roundedRect(421, PAGE.top, 126, 30, 5)
      .fill(COLOR.soft);
    document
      .font("Helvetica-Bold")
      .fontSize(title.length > 12 ? 10 : 15)
      .fillColor(primary)
      .text(title, 421, PAGE.top + 8, { width: 126, align: "center" });
    if (qr) {
      const qrTop = 172 + (hasSeparateOperationDate(invoice) ? 20 : 0);
      document
        .font("Helvetica-Bold")
        .fontSize(7)
        .fillColor(COLOR.ink)
        .text("QR tributario:", 451, qrTop, { width: 96, align: "center" });
      document.image(qr, 451, qrTop + 12, { fit: [96, 96] });
    }
    document.y = 106;
  }

  private rectification(
    document: PDFKit.PDFDocument,
    invoice: InvoicePdfInput,
  ) {
    const top = document.y + 12;
    const reason = invoice.rectificationReason ?? "-";
    const vatRecovery = isVatRecovery(invoice);
    const height = Math.max(
      vatRecovery ? 82 : 62,
      document.heightOfString(reason, { width: 475, lineGap: 2 }) + (vatRecovery ? 62 : 42),
    );
    document
      .roundedRect(PAGE.left, top, PAGE.right - PAGE.left, height, 8)
      .strokeColor(COLOR.primary)
      .lineWidth(1)
      .stroke();
    document
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(COLOR.primary)
      .text("RECTIFICA", PAGE.left + 14, top + 11);
    document
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(COLOR.ink)
      .text(
        invoice.originalInvoice?.fullNumber ?? "-",
        PAGE.left + 82,
        top + 10,
      )
      .text(
        `${invoice.sifInvoiceType ?? "R4"} · ${rectificationKind(invoice.rectificationKind)} · ${rectificationImpact(invoice.rectificationImpact)}`,
        345,
        top + 10,
        { width: 188, align: "right" },
      )
      .font("Helvetica-Bold")
      .text("Motivo", PAGE.left + 14, top + 30)
      .font("Helvetica")
      .fillColor(COLOR.muted)
      .text(reason, PAGE.left + 62, top + 30, { width: 471, lineGap: 2 });
    if (vatRecovery && invoice.originalInvoice?.issueDate) {
      document.font("Helvetica").fontSize(8).fillColor(COLOR.muted)
        .text(`Emisión original: ${formatDate(invoice.originalInvoice.issueDate)} · Operación original: ${formatDate(invoice.originalInvoice.operationDate ?? invoice.operationDate ?? invoice.issueDate)}`,
          PAGE.left + 14, top + height - 19, { width: 465 });
    }
    document.y = top + height;
  }

  private vatRecoveryAdjustment(document: PDFKit.PDFDocument, invoice: InvoicePdfInput) {
    this.ensureSpace(document, 92, invoice.fullNumber);
    const y = document.y + 20;
    document.roundedRect(PAGE.left, y, PAGE.right - PAGE.left, 72, 6)
      .strokeColor(COLOR.line).stroke();
    document.font("Helvetica-Bold").fontSize(9).fillColor(COLOR.ink)
      .text(vatRecoveryDescription(invoice.sifInvoiceType!), PAGE.left + 12, y + 10);
    document.font("Helvetica").fontSize(8).fillColor(COLOR.muted)
      .text(`Tipo IVA original: ${decimal(invoice.lines[0].taxRate, 2)}% · Base de la diferencia: ${money(invoice.subtotal, invoice.currency)}`,
        PAGE.left + 12, y + 29, { width: 465 })
      .text(`Cuota rectificada: ${signedMoney(invoice.taxTotal, invoice.currency, true)} · Total de la diferencia: ${signedMoney(invoice.total, invoice.currency, true)}`,
        PAGE.left + 12, y + 48, { width: 465 });
    document.y = y + 92;
  }

  private parties(
    document: PDFKit.PDFDocument,
    invoice: InvoicePdfInput,
    issuer: IssuerSnapshot,
  ) {
    const top = document.y;
    const primary = issuerPrimaryColor(issuer);
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
      ["Nº de factura", invoice.fullNumber],
      ["Fecha de emisión", formatDate(invoice.issueDate)],
      ...(hasSeparateOperationDate(invoice)
        ? [["Fecha de operación", formatDate(invoice.operationDate)]]
        : []),
      ["Fecha de vencimiento", invoice.dueDate ? formatDate(invoice.dueDate) : "-"],
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
      .text(invoice.customerLegalName, PAGE.left, customerTop + 19, {
        width: 300,
      });
    const details = [
      invoice.customerTaxId ? `NIF: ${invoice.customerTaxId}` : null,
      ...addressLines(invoice.billingAddress),
    ].filter((value): value is string => Boolean(value));
    document
      .font("Helvetica")
      .fontSize(8.5)
      .fillColor(COLOR.muted)
      .text(
        details.join("\n") || "Sin dirección de facturación",
        PAGE.left,
        customerTop + 36,
        {
          width: 330,
          lineGap: 2,
        },
      );
    document.y = Math.max(
      customerTop +
        36 +
        document.heightOfString(
          details.join("\n") || "Sin dirección de facturación",
          { width: 330, lineGap: 2 },
        ) +
        12,
      invoice.sifQr ? 292 + (hasSeparateOperationDate(invoice) ? 20 : 0) : 0,
    );
  }

  private continuation(document: PDFKit.PDFDocument, number: string) {
    document
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(COLOR.ink)
      .text(`Factura ${number} · continuación`, PAGE.left, PAGE.top);
    document.y = 70;
  }

  private tableHeader(document: PDFKit.PDFDocument, y: number) {
    document
      .roundedRect(PAGE.left, y, PAGE.right - PAGE.left, 28, 5)
      .fill(COLOR.soft);
    const cells = [
      ["Descripción", 58, 190, "left"],
      ["Cant.", 258, 45, "right"],
      ["Precio", 313, 60, "right"],
      ["Dto.", 383, 45, "right"],
      ["IVA", 438, 35, "right"],
      ["Total", 483, 54, "right"],
    ] as const;
    document.font("Helvetica-Bold").fontSize(7.5).fillColor(COLOR.ink);
    cells.forEach(([label, x, width, align]) =>
      document.text(label.toUpperCase(), x, y + 10, { width, align }),
    );
    return y + 28;
  }

  private line(
    document: PDFKit.PDFDocument,
    line: InvoicePdfInput["lines"][number],
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
      [decimal(line.quantity, 3), 258, 45, "right"],
      [money(line.unitPrice, currency), 313, 60, "right"],
      [`${decimal(line.discountPct, 2)}%`, 383, 45, "right"],
      [`${decimal(line.taxRate, 2)}%`, 438, 35, "right"],
      [money(line.totalAmount, currency), 483, 54, "right"],
    ] as const;
    document.font("Helvetica").fontSize(7.5).fillColor(COLOR.ink);
    cells.forEach(([value, x, width, align]) =>
      document.text(value, x, y + 7, { width, align, lineGap: 1 }),
    );
  }

  private totals(document: PDFKit.PDFDocument, invoice: InvoicePdfInput) {
    const x = 345;
    let y = document.y;
    const rows = [
      ["Subtotal", money(invoice.subtotal, invoice.currency)],
      ["Descuentos", discountMoney(invoice.discountTotal, invoice.currency)],
      ["IVA", signedMoney(invoice.taxTotal, invoice.currency, isVatRecovery(invoice))],
    ];
    rows.forEach(([label, value]) => {
      document
        .font("Helvetica")
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(label, x, y);
      document.fillColor(COLOR.ink).text(value, x + 82, y, {
        width: PAGE.right - x - 82,
        align: "right",
      });
      y += 20;
    });
    document.roundedRect(x - 10, y + 3, PAGE.right - x + 10, 34, 5).fill(COLOR.soft);
    document
      .font("Helvetica-Bold")
      .fontSize(12)
      .fillColor(COLOR.primary)
      .text("Total", x, y + 14);
    document
      .fillColor(COLOR.primary)
      .text(signedMoney(invoice.total, invoice.currency, isVatRecovery(invoice)), x + 82, y + 14, {
        width: PAGE.right - x - 82,
        align: "right",
      });
    document.y = y + 48;
  }

  private notesAndTerms(
    document: PDFKit.PDFDocument,
    invoice: InvoicePdfInput,
    issuer: IssuerSnapshot,
  ) {
    if (!invoice.notes && !issuer.defaultNotes && !issuer.paymentInstructions &&
        !issuer.bankIban && !issuer.paymentTerms && !invoice.dueDate) return;
    const primary = issuerPrimaryColor(issuer);
    const notes =
      truncatePdfText([invoice.notes, issuer.defaultNotes].filter(Boolean).join("\n")) ||
      "Sin notas adicionales.";
    const terms = truncatePdfText([
      issuer.paymentInstructions,
      issuer.bankIban ? `IBAN: ${issuer.bankIban}` : null,
      issuer.paymentTerms,
      invoice.dueDate
        ? `Vencimiento: ${formatDate(invoice.dueDate)}`
        : "Vencimiento no especificado",
      `Moneda: ${invoice.currency}`,
    ]
      .filter(Boolean)
      .join("\n"));
    const contentHeight = Math.max(
      90,
      document.heightOfString(notes, { width: 230, lineGap: 2 }) + 52,
      document.heightOfString(terms, { width: 229, lineGap: 2 }) + 52,
    );
    this.ensureSpace(document, contentHeight + 28, invoice.fullNumber);
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
    height: number,
    number: string,
  ) {
    if (document.y + height <= PAGE.bottom) return;
    document.addPage();
    this.continuation(document, number);
  }

  private footers(
    document: PDFKit.PDFDocument,
    invoice: InvoicePdfInput,
    issuer: IssuerSnapshot,
  ) {
    const range = document.bufferedPageRange();
    for (let page = range.start; page < range.start + range.count; page += 1) {
      document.switchToPage(page);
      document
        .moveTo(PAGE.left, PAGE.footer - 8)
        .lineTo(PAGE.right, PAGE.footer - 8)
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
          PAGE.footer,
          { width: 300, lineBreak: false },
        );
      document.text(`Pastagansa · Página ${page + 1} de ${range.count}`, 347, PAGE.footer, {
        width: 200,
        align: "right",
        lineBreak: false,
      });
    }
  }
}

function hasSeparateOperationDate(
  invoice: InvoicePdfInput,
): invoice is InvoicePdfInput & { operationDate: Date } {
  return Boolean(
    invoice.operationDate &&
      invoice.operationDate.getTime() !== invoice.issueDate.getTime(),
  );
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(value);
}

function decimal(value: DecimalValue, digits: number) {
  return new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: digits,
  }).format(Number(value.toString()));
}

function money(value: DecimalValue, currency: string) {
  return `${new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value.toString()))} ${currency}`;
}

function signedMoney(value: DecimalValue, currency: string, negative: boolean) {
  return negative && Number(value.toString()) !== 0 ? `-${money(value, currency)}` : money(value, currency);
}

function isVatRecovery(invoice: InvoicePdfInput) {
  return invoice.documentType === "CREDIT_NOTE" &&
    (invoice.sifInvoiceType === "R2" || invoice.sifInvoiceType === "R3");
}

function discountMoney(value: DecimalValue, currency: string) {
  const formatted = money(value, currency);
  return Number(value.toString()) === 0 ? formatted : `-${formatted}`;
}

function rectificationKind(value: string | null | undefined) {
  return (
    {
      TOTAL: "Total",
      PARTIAL: "Parcial",
      DIFFERENCE: "Por diferencias",
    }[value ?? ""] ?? "Rectificación"
  );
}

function rectificationImpact(value: string | null | undefined) {
  return value === "INCREASE" ? "Aumento" : "Disminución";
}

function addressLines(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const address = value as Record<string, unknown>;
  const text = (field: string) =>
    typeof address[field] === "string" && address[field]
      ? String(address[field])
      : null;
  return [
    text("line1"),
    text("line2"),
    [text("postalCode"), text("city")].filter(Boolean).join(" ") || null,
    [text("province"), text("country")].filter(Boolean).join(" · ") || null,
  ].filter((line): line is string => Boolean(line));
}
