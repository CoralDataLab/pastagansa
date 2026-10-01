import "server-only";
import { NextResponse } from "next/server";
import { SessionError, tenantApiRequest } from "./server-session";
import { normalizeApiError } from "./session";

export async function forwardPurchaseProposal(
  path: string,
  init?: RequestInit,
) {
  try {
    const response = await tenantApiRequest(
      `/v1/purchase-command-proposals${path}`,
      init,
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
