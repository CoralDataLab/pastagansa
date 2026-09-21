import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

const bodySchema = z.object({
  invoiceDataConfirmed: z.literal(true),
  resolutionNote: z.string().trim().min(20).max(1000),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = z.uuid().safeParse((await params).id);
  const body = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!id.success || !body.success)
    return NextResponse.json({ error: "Confirma los datos de la factura y explica la resolución de la incidencia (mínimo 20 caracteres)." }, { status: 400 });
  try {
    const response = await tenantApiRequest(
      `/v1/sif/records/${id.data}/rejected-registration-recovery`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body.data) },
    );
    const result = await response.json().catch(() => undefined);
    if (!response.ok)
      return NextResponse.json({ error: normalizeApiError(result) }, { status: response.status });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "No podemos recuperar el registro SIF." }, { status: 503 });
  }
}
