import { NextResponse } from "next/server";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

export async function GET() {
  try {
    const response = await tenantApiRequest("/v1/sif/records/test-submissions/overview");
    const body = await response.json().catch(() => undefined);
    if (!response.ok)
      return NextResponse.json({ error: normalizeApiError(body) }, { status: response.status });
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "No podemos conectar con el servicio." }, { status: 503 });
  }
}
