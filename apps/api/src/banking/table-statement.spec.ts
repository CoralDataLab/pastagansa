import * as XLSX from "xlsx";
import {
  columnNames,
  readMovements,
  readTable,
  suggestMapping,
  TableFormatError,
  TableMapping,
} from "./table-statement";

const spanishCsv = [
  "Cuenta;ES91 2100 0418 4502 0005 1332",
  "Titular;MUÑOZ Y ASOCIADOS SL",
  "",
  "Fecha operación;Fecha valor;Concepto;Importe;Saldo",
  '03/09/2026;04/09/2026;"TRANSFERENCIA; CLIENTE A";1.210,00;2.210,00',
  "10/09/2026;10/09/2026;COMISION MANTENIMIENTO;-45,50 EUR;2.164,50",
  ";;Saldo final;;2.164,50",
].join("\r\n");

const spanishMapping: TableMapping = {
  headerRow: 3,
  delimiter: ";",
  dateColumn: "Fecha operación",
  valueDateColumn: "Fecha valor",
  amountMode: "SIGNED",
  amountColumn: "Importe",
  decimalSeparator: ",",
  descriptionColumns: ["Concepto"],
};

function workbook(bookType: XLSX.BookType) {
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Movimientos de la cuenta"],
    [],
    ["Fecha", "Concepto", "Importe"],
    [new Date(2026, 8, 3), "Transferencia cliente", 1210],
    [new Date(2026, 8, 10), "Comisión", -45.5],
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Movimientos");
  return XLSX.write(book, { type: "buffer", bookType }) as Buffer;
}

describe("CSV and Excel statements", () => {
  it("reads a Spanish bank CSV with a preamble, quotes and a closing balance line", () => {
    const table = readTable(Buffer.from(spanishCsv, "latin1"));
    expect(table).toMatchObject({ format: "CSV", delimiter: ";" });
    expect(table.rows[1][1]).toBe("MUÑOZ Y ASOCIADOS SL");
    expect(suggestMapping(table)).toEqual(spanishMapping);
    expect(readMovements(table, spanishMapping)).toMatchObject({
      movements: [
        {
          operationDate: "2026-09-03",
          valueDate: "2026-09-04",
          amountCents: 121_000,
          description: "TRANSFERENCIA; CLIENTE A",
          reference: null,
        },
        { operationDate: "2026-09-10", amountCents: -4_550, description: "COMISION MANTENIMIENTO" },
      ],
      errors: [],
      errorCount: 0,
      ignored: 1,
    });
  });

  it("keeps IDs stable across overlapping files and distinct for identical rows", () => {
    const rows = (lines: string[]) =>
      readMovements(readTable(Buffer.from(["Fecha;Concepto;Importe", ...lines].join("\n"))), {
        ...spanishMapping,
        headerRow: 0,
        dateColumn: "Fecha",
        valueDateColumn: undefined,
      }).movements.map(({ externalId }) => externalId);
    const september = rows(["05/09/2026;CAFE;-1,20", "05/09/2026;CAFE;-1,20"]);
    const october = rows(["05/09/2026;CAFE;-1,20", "05/09/2026;CAFE;-1,20", "02/10/2026;NOMINA;1500"]);
    expect(september[0]).toMatch(/^tab:[0-9a-f]{64}$/);
    expect(september[0]).not.toBe(september[1]);
    expect(october.slice(0, 2)).toEqual(september);
  });

  it("reads debit and credit columns, ISO dates and decimal points", () => {
    const table = readTable(
      Buffer.from(
        ["Date,Description,Debit,Credit,Reference", "2026-09-03,Payment received,,121.00,F2026-00001", "2026-09-10,Fee,45.50,,"].join("\n"),
      ),
    );
    expect(table.delimiter).toBe(",");
    const { movements } = readMovements(table, {
      headerRow: 0,
      dateColumn: "Date",
      amountMode: "SPLIT",
      debitColumn: "Debit",
      creditColumn: "Credit",
      decimalSeparator: ".",
      descriptionColumns: ["Description"],
      referenceColumn: "Reference",
    });
    expect(movements.map(({ amountCents, reference }) => [amountCents, reference])).toEqual([
      [12_100, "F2026-00001"],
      [-4_550, null],
    ]);
  });

  it("suggests separate debit and credit columns from Spanish headers", () => {
    const table = readTable(Buffer.from("Fecha;Concepto;Cargo;Abono\n03/09/2026;Pago;12,00;\n"));
    expect(suggestMapping(table)).toMatchObject({
      amountMode: "SPLIT",
      debitColumn: "Cargo",
      creditColumn: "Abono",
    });
  });

  it.each([
    ["XLSX", "xlsx"],
    ["XLS", "biff8"],
  ] as const)("reads dates and numbers from %s spreadsheets", (format, bookType) => {
    const table = readTable(workbook(bookType));
    expect(table.format).toBe(format);
    const mapping = suggestMapping(table);
    expect(mapping).toMatchObject({ headerRow: 2, dateColumn: "Fecha", amountColumn: "Importe" });
    expect(
      readMovements(table, mapping).movements.map(({ operationDate, amountCents }) => [operationDate, amountCents]),
    ).toEqual([
      ["2026-09-03", 121_000],
      ["2026-09-10", -4_550],
    ]);
  });

  it("keeps text from HTML tables saved as .xls without guessing dates", () => {
    const table = readTable(
      Buffer.from(
        "<html><body><table><tr><td>Fecha</td><td>Concepto</td><td>Importe</td></tr>" +
          "<tr><td>03/09/2026</td><td>Transferencia</td><td>1.210,00 €</td></tr></table></body></html>",
      ),
    );
    expect(table.format).toBe("XLS");
    expect(readMovements(table, suggestMapping(table)).movements[0]).toMatchObject({
      operationDate: "2026-09-03",
      amountCents: 121_000,
    });
  });

  it("reports invalid rows with their spreadsheet row number", () => {
    const table = readTable(
      Buffer.from(["Fecha;Concepto;Importe", "31/02/2026;Fecha imposible;10,00", "01/09/2026;Sin importe;", "02/09/2026;Texto;diez"].join("\n")),
    );
    expect(readMovements(table, { ...spanishMapping, headerRow: 0, dateColumn: "Fecha", valueDateColumn: undefined })).toMatchObject({
      movements: [],
      errorCount: 3,
      errors: [
        { row: 2, message: 'The date "31/02/2026" is not a valid DD/MM/YYYY or YYYY-MM-DD date' },
        { row: 3, message: "The amount is empty" },
        { row: 4, message: 'The amount "diez" is not valid' },
      ],
    });
  });

  it("rejects mappings that do not match the file and malformed CSV", () => {
    const table = readTable(Buffer.from("Fecha;Concepto;Importe\n"));
    expect(() => readMovements(table, { ...spanishMapping, headerRow: 0 })).toThrow(
      new TableFormatError('Column "Fecha operación" is not in the header row'),
    );
    expect(() => readTable(Buffer.from('Fecha;"Concepto\n'))).toThrow("The CSV has an unclosed quoted field");
  });

  it("names blank and repeated header cells", () => {
    expect(columnNames(["Fecha", "", "Importe", "Importe"])).toEqual(["Fecha", "Columna 2", "Importe", "Importe (2)"]);
  });
});
