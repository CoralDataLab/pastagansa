import { NextResponse } from "next/server";
import { z } from "zod";
import { paymentInputSchema } from "@/lib/invoices";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

const schema = paymentInputSchema.extend({
  idempotencyKey: z.string().trim().min(1).max(128),
  paidByShareholder: z.boolean().optional(),
});

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success)
    return NextResponse.json({ error: "Compra no válida." }, { status: 400 });
  return forward(`/v1/purchase-invoices/${id.data}/payments`);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const [id, input] = await Promise.all([
    z.uuid().safeParseAsync((await params).id),
    schema.safeParseAsync(await request.json().catch(() => undefined)),
  ]);
  if (!id.success || !input.success)
    return NextResponse.json(
      { error: "Revisa el importe, la fecha y el método de pago." },
      { status: 400 },
    );
  const { idempotencyKey, ...payment } = input.data;
  return forward(`/v1/purchase-invoices/${id.data}/payments`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payment),
  });
}

async function forward(path: string, init?: RequestInit) {
  try {
    const response = await tenantApiRequest(path, init);
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
