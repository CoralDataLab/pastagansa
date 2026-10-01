import { NextRequest, NextResponse } from "next/server";
import { purchaseInputSchema } from "@/lib/purchases";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

export async function GET(request: NextRequest) {
  const params = new URLSearchParams();
  for (const name of ["status", "cursor", "limit"] as const) {
    const value = request.nextUrl.searchParams.get(name);
    if (value) params.set(name, value);
  }
  return forward(`/v1/purchase-invoices?${params}`);
}

export async function POST(request: Request) {
  const input = purchaseInputSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!input.success)
    return NextResponse.json(
      { error: "Revisa el proveedor, número, fechas y conceptos." },
      { status: 400 },
    );
  return forward("/v1/purchase-invoices", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(request.headers.get("idempotency-key")
        ? { "idempotency-key": request.headers.get("idempotency-key")! }
        : {}),
    },
    body: JSON.stringify({
      ...input.data,
      dueDate: input.data.dueDate || undefined,
      notes: input.data.notes || undefined,
    }),
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
