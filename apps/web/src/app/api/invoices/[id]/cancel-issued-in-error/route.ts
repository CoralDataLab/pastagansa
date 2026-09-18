import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

const inputSchema = z.object({
  reason: z.string().trim().min(20).max(1000),
  operationDidNotExist: z.literal(true),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const [id, input] = await Promise.all([
    z.uuid().safeParseAsync((await params).id),
    inputSchema.safeParseAsync(await request.json().catch(() => undefined)),
  ]);
  if (!id.success || !input.success)
    return NextResponse.json(
      {
        error:
          "Confirma que la operación no existió e indica un motivo de al menos 20 caracteres.",
      },
      { status: 400 },
    );
  try {
    const response = await tenantApiRequest(
      `/v1/invoices/${id.data}/cancel-issued-in-error`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input.data),
      },
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok)
      return NextResponse.json(
        { error: normalizeApiError(body) },
        { status: response.status },
      );
    return NextResponse.json(body);
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
