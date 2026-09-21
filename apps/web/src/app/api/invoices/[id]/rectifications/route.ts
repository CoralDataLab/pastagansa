import { NextResponse } from "next/server";
import { z } from "zod";
import { rectificationInputSchema } from "@/lib/invoices";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const [id, input] = await Promise.all([
    z.uuid().safeParseAsync((await params).id),
    rectificationInputSchema.safeParseAsync(
      await request.json().catch(() => undefined),
    ),
  ]);
  if (!id.success || !input.success)
    return NextResponse.json(
      { error: "Revisa el motivo fiscal, la fecha y la explicación." },
      { status: 400 },
    );
  try {
    const response = await tenantApiRequest(
      `/v1/invoices/${id.data}/rectifications`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input.data,
          kind: input.data.sifInvoiceType === "R2" || input.data.sifInvoiceType === "R3" ? "DIFFERENCE" : "TOTAL",
          impact: "DECREASE",
          dueDate: input.data.dueDate || undefined,
          notes: input.data.notes || undefined,
        }),
      },
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok)
      return NextResponse.json(
        { error: normalizeApiError(body) },
        { status: response.status },
      );
    return NextResponse.json(body, { status: response.status });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json(
        { error: error.message },
        { status: error.status },
      );
    return NextResponse.json(
      { error: "No podemos conectar con el servicio." },
      { status: 503 },
    );
  }
}
