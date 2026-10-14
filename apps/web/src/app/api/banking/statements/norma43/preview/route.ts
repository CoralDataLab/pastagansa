import { forwardNorma43 } from "../forward";

export async function POST(request: Request) {
  return forwardNorma43(request, "preview");
}
