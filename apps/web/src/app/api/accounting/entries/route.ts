import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { manualEntrySchema } from "@/lib/accounting";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

const createSchema = manualEntrySchema.safeExtend({ idempotencyKey: z.uuid() });

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success)
    return NextResponse.json({ error: "Comprueba fecha, cuentas, importes y que el asiento cuadre." }, { status: 400 });
  const { idempotencyKey, ...entry } = parsed.data;
  try {
    const response = await tenantApiRequest("/v1/accounting/journal-entries", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(entry),
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok)
      return NextResponse.json({ error: normalizeApiError(body) }, { status: response.status });
    return NextResponse.json(body, { status: response.status });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "No se pudo confirmar el asiento. Reintenta sin modificarlo para evitar duplicados." }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  const query = new URLSearchParams();
  for (const name of ["from", "to", "limit"] as const) {
    const value = request.nextUrl.searchParams.get(name);
    if (value) query.set(name, value);
  }
  try {
    const response = await tenantApiRequest(
      `/v1/accounting/journal-entries?${query}`,
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
      { error: "No podemos cargar el diario." },
      { status: 503 },
    );
  }
}
