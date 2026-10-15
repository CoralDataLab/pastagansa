import { forwardStatement } from "../../forward";

export async function POST(request: Request) {
  return forwardStatement(request, "norma43/import", ["bankAccountId", "fileSha256"]);
}
