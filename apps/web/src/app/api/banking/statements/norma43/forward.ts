import { NextResponse } from "next/server";
import { translateStatementError } from "@/lib/banking";
import { normalizeApiError } from "@/lib/session";
import { SessionError, tenantApiRequest } from "@/lib/server-session";

const fields = {
  preview: ["bankAccountId"],
  import: ["bankAccountId", "fileSha256"],
} as const;

/** Forwards a Norma 43 upload, with the fields its step accepts, to the API. */
export async function forwardNorma43(request: Request, step: keyof typeof fields) {
  const incoming = await request.formData().catch(() => undefined);
  const file = incoming?.get("file");
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "Selecciona un fichero Norma 43." }, { status: 400 });
  const body = new FormData();
  body.set("file", file, file.name);
  for (const field of fields[step]) {
    const value = incoming?.get(field);
    if (typeof value === "string" && value) body.set(field, value);
  }
  try {
    const response = await tenantApiRequest(`/v1/banking/statements/norma43/${step}`, {
      method: "POST",
      body,
    });
    const json = await response.json().catch(() => undefined);
    if (!response.ok)
      return NextResponse.json(
        { error: translateStatementError(normalizeApiError(json)) },
        { status: response.status },
      );
    return NextResponse.json(json, { status: response.status });
  } catch (error) {
    if (error instanceof SessionError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: "No podemos procesar el extracto." }, { status: 503 });
  }
}
