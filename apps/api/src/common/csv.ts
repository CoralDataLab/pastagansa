import { BadRequestException } from "@nestjs/common";

/** RFC 4180 style rows: quoted fields may contain the delimiter, newlines and doubled quotes. */
export function parseCsv(csv: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const character = csv[i];
    if (quoted) {
      if (character === '"' && csv[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += character;
  }
  if (quoted) throw new BadRequestException("CSV has an unclosed quoted field");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}
