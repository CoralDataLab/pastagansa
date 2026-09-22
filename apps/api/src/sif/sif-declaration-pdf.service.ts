import { Injectable } from "@nestjs/common";
import PDFDocument = require("pdfkit");

export type SifDeclarationInput = {
  company: {
    legalName: string;
    taxId: string;
    sifSoftwareProducerName: string | null;
    sifSoftwareProducerTaxId: string | null;
    sifSoftwareName: string | null;
    sifSoftwareId: string | null;
    sifSoftwareVersion: string | null;
    sifInstallationNumber: string | null;
    documentProfile: {
      addressLine1: string | null;
      addressLine2: string | null;
      postalCode: string | null;
      city: string | null;
      province: string | null;
      addressCountry: string | null;
      email: string | null;
      website: string | null;
    } | null;
  };
};

const PAGE = { left: 54, right: 541, top: 54, bottom: 742, footer: 776 };
const COLOR = {
  ink: "#10233F",
  muted: "#52627A",
  primary: "#F71950",
  soft: "#FDECF1",
  line: "#D9DEE7",
  warning: "#8A5E00",
  warningSoft: "#FFF6DE",
};

@Injectable()
export class SifDeclarationPdfService {
  async render(input: SifDeclarationInput): Promise<Buffer> {
    const document = new PDFDocument({
      size: "A4",
      margins: { top: PAGE.top, right: 54, bottom: 54, left: PAGE.left },
      bufferPages: true,
      info: {
        Title: "Borrador de declaración responsable SIF",
        Author: input.company.sifSoftwareProducerName ?? input.company.legalName,
        Subject: "Declaración responsable del productor del sistema informático de facturación",
        Creator: "Pastagansa",
      },
    });
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      document.on("data", (chunk: Buffer) => chunks.push(chunk));
      document.on("end", () => resolve(Buffer.concat(chunks)));
      document.on("error", reject);
    });

    this.header(document);
    this.notice(document);
    this.section(document, "1. Identificación del sistema informático");
    this.fields(document, [
      ["Nombre del software", value(input.company.sifSoftwareName)],
      ["Identificador", value(input.company.sifSoftwareId)],
      ["Versión", value(input.company.sifSoftwareVersion)],
      ["Número de instalación", value(input.company.sifInstallationNumber)],
      ["Modalidades previstas", "VERI*FACTU y NO VERI*FACTU. Ambas limitadas a pruebas; falta completar la revisión de conformidad y activar producción."],
    ]);
    this.section(document, "2. Productor del sistema informático");
    this.fields(document, [
      ["Razón social", value(input.company.sifSoftwareProducerName)],
      ["NIF", value(input.company.sifSoftwareProducerTaxId)],
      ["Contacto", contact(input.company)],
    ]);
    this.section(document, "3. Declaración del productor");
    const declaration =
      "La persona o entidad productora identificada en este documento deberá declarar, para la versión indicada, que el sistema informático cumple la normativa aplicable a los sistemas de facturación. Este borrador reúne los datos de identificación disponibles para su revisión previa.";
    const declarationTop = document.y;
    document.font("Helvetica").fontSize(9.5);
    const declarationHeight = document.heightOfString(declaration, {
      width: PAGE.right - PAGE.left,
      lineGap: 3,
    });
    document
      .fillColor(COLOR.ink)
      .text(
        declaration,
        PAGE.left,
        declarationTop,
        { width: PAGE.right - PAGE.left, lineGap: 3 },
      );
    document.y = declarationTop + declarationHeight + 16;
    this.section(document, "4. Pendiente antes de su formalización");
    this.bullets(document, [
      "Revisión técnica y normativa completa de la versión del software.",
      "Datos de localización del productor, lugar y fecha de suscripción.",
      "Firma o suscripción por la persona o entidad productora.",
      "VERI*FACTU: transporte y certificado de producción, pruebas y respuesta AEAT documentadas.",
      "NO VERI*FACTU: validar certificado y firma XAdES-EPES con tercero; completar registro de eventos, alarmas y exportación de eventos por período.",
      "Completar todos los datos y evidencias del artículo 15 de la Orden HAC/1177/2024 para esta versión.",
    ]);
    document
      .font("Helvetica-Oblique")
      .fontSize(8)
      .fillColor(COLOR.muted)
      .text(
        "Referencia: RD 1007/2023, Orden HAC/1177/2024 y documentación técnica vigente de la AEAT.",
        PAGE.left,
        document.y + 14,
        { width: PAGE.right - PAGE.left },
      );
    this.footer(document);
    document.end();
    return completed;
  }

  private header(document: PDFKit.PDFDocument) {
    document
      .font("Helvetica-Bold")
      .fontSize(8)
      .fillColor(COLOR.primary)
      .text("SISTEMA INFORMÁTICO DE FACTURACIÓN", PAGE.left, PAGE.top);
    document
      .font("Helvetica-Bold")
      .fontSize(19)
      .fillColor(COLOR.ink)
      .text("Declaración responsable", PAGE.left, PAGE.top + 18);
    document
      .roundedRect(397, PAGE.top + 8, 144, 27, 5)
      .fill(COLOR.soft)
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COLOR.primary)
      .text("BORRADOR", 397, PAGE.top + 17, { width: 144, align: "center" });
    document.y = PAGE.top + 61;
  }

  private notice(document: PDFKit.PDFDocument) {
    const top = document.y;
    document
      .roundedRect(PAGE.left, top, PAGE.right - PAGE.left, 53, 6)
      .fill(COLOR.warningSoft)
      .font("Helvetica-Bold")
      .fontSize(9)
      .fillColor(COLOR.warning)
      .text("Documento de preparación - no es una certificación final", PAGE.left + 14, top + 11)
      .font("Helvetica")
      .fontSize(8.5)
      .text(
        "No activa VERI*FACTU ni acredita por sí solo el cumplimiento normativo. Debe ser revisado y suscrito por el productor antes de utilizarse como declaración responsable.",
        PAGE.left + 14,
        top + 25,
        { width: PAGE.right - PAGE.left - 28, lineGap: 2 },
      );
    document.y = top + 70;
  }

  private section(document: PDFKit.PDFDocument, title: string) {
    document
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(COLOR.primary)
      .text(title, PAGE.left, document.y, { width: PAGE.right - PAGE.left });
    document.y += 8;
  }

  private fields(document: PDFKit.PDFDocument, fields: Array<[string, string]>) {
    for (const [label, fieldValue] of fields) {
      const top = document.y;
      const height = Math.max(25, document.heightOfString(fieldValue, { width: 292, lineGap: 2 }) + 12);
      document
        .rect(PAGE.left, top, PAGE.right - PAGE.left, height)
        .strokeColor(COLOR.line)
        .lineWidth(0.5)
        .stroke();
      document
        .font("Helvetica-Bold")
        .fontSize(8)
        .fillColor(COLOR.muted)
        .text(label.toUpperCase(), PAGE.left + 11, top + 8, { width: 158 });
      document
        .font("Helvetica")
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(fieldValue, PAGE.left + 178, top + 8, { width: 298, lineGap: 2 });
      document.y = top + height;
    }
    document.y += 16;
  }

  private bullets(document: PDFKit.PDFDocument, entries: string[]) {
    for (const entry of entries) {
      const top = document.y;
      document.circle(PAGE.left + 3, top + 5, 1.5).fill(COLOR.primary);
      document
        .font("Helvetica")
        .fontSize(9)
        .fillColor(COLOR.ink)
        .text(entry, PAGE.left + 13, top, { width: PAGE.right - PAGE.left - 13, lineGap: 3 });
      document.y = top + document.heightOfString(entry, { width: PAGE.right - PAGE.left - 13, lineGap: 3 }) + 7;
    }
  }

  private footer(document: PDFKit.PDFDocument) {
    const range = document.bufferedPageRange();
    for (let page = 0; page < range.count; page += 1) {
      document.switchToPage(page);
      document
        .moveTo(PAGE.left, PAGE.footer - 16)
        .lineTo(PAGE.right, PAGE.footer - 16)
        .strokeColor(COLOR.line)
        .lineWidth(0.5)
        .stroke();
      document
        .font("Helvetica")
        .fontSize(8)
        .fillColor(COLOR.muted)
        .text("Pastagansa · Borrador de declaración responsable SIF", PAGE.left, PAGE.footer)
        .text(`Página ${page + 1} de ${range.count}`, 425, PAGE.footer, { width: 116, align: "right" });
    }
  }
}

function value(input: string | null) {
  return input?.trim() || "Pendiente de completar";
}

function contact(input: SifDeclarationInput["company"]) {
  const profile = input.documentProfile;
  const address = [
    profile?.addressLine1,
    profile?.addressLine2,
    [profile?.postalCode, profile?.city].filter(Boolean).join(" ") || null,
    [profile?.province, profile?.addressCountry].filter(Boolean).join(" · ") || null,
  ].filter((part): part is string => Boolean(part));
  return [address.join(", "), profile?.email, profile?.website]
    .filter((part): part is string => Boolean(part))
    .join(" · ") || "Pendiente de completar";
}
