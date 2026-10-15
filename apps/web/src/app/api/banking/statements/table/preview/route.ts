import { forwardStatement } from "../../forward";

export async function POST(request: Request) {
  return forwardStatement(request, "table/preview", ["bankAccountId", "mapping"]);
}
