import { forwardStatement } from "../../forward";

export async function POST(request: Request) {
  return forwardStatement(request, "table/import", ["bankAccountId", "mapping", "fileSha256"]);
}
