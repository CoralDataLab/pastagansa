import "server-only";
import { NextResponse } from "next/server";
import { createProposalSchema } from "./purchase-proposals";
import { forwardPurchaseProposal } from "./server-purchase-proposals";

export async function forwardProposalIntake(request: Request, action: "ocr-preview" | "from-document") {
  let form: FormData;
  try { form = await request.formData(); }
  catch { return NextResponse.json({ error: "Archivo no válido." }, { status: 400 }); }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0 || file.size > 10 * 1024 * 1024)
    return NextResponse.json({ error: "Adjunta un archivo de hasta 10 MiB." }, { status: 400 });
  const body = new FormData();
  body.set("file", file, file.name);
  if (action === "from-document") {
    let input: unknown;
    try { input = JSON.parse(String(form.get("proposal"))); }
    catch { return NextResponse.json({ error: "Datos de factura no válidos." }, { status: 400 }); }
    const parsed = createProposalSchema.safeParse(input);
    if (!parsed.success)
      return NextResponse.json({ error: "Revisa proveedor, fechas y datos de factura." }, { status: 400 });
    body.set("proposal", JSON.stringify(parsed.data));
    const ocrPreview = form.get("ocrPreview");
    if (ocrPreview !== null) {
      // Matches the API multipart fieldSize; the signed preview must arrive intact or not at all.
      if (typeof ocrPreview !== "string" || new TextEncoder().encode(ocrPreview).length > 1024 * 1024)
        return NextResponse.json({ error: "La lectura OCR no es válida; vuelve a leer la imagen." }, { status: 400 });
      body.set("ocrPreview", ocrPreview);
    }
  }
  return forwardPurchaseProposal(`/${action}`, { method: "POST", body });
}
