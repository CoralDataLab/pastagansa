import { NextResponse } from "next/server";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

export async function GET(request: Request) {
  const year = new URL(request.url).searchParams.get("year") ?? "";
  if (!/^20\d{2}$/.test(year))
    return NextResponse.json({ error: "Ejercicio no válido." }, { status: 400 });
  try {
    const response = await tenantApiRequest(`/v1/purchase-invoices/withholdings?year=${year}`);
    return NextResponse.json(await response.json(), { status: response.status, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: normalizeApiError(undefined) }, { status: 503 });
  }
}
