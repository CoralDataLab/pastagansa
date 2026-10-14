/** Builds Norma 43 files with exact 80-character records for tests. */

export type TestMovement = {
  cents: number;
  date?: string;
  valueDate?: string;
  commonConcept?: string;
  ownConcept?: string;
  document?: string;
  reference1?: string;
  reference2?: string;
  concepts?: string[];
};

export type TestAccount = {
  bank?: string;
  branch?: string;
  account?: string;
  holder?: string;
  start?: string;
  end?: string;
  openingCents?: number;
  /** Overrides the computed closing balance. */
  closingCents?: number;
  /** Overrides the computed debit count in record 33. */
  debitCount?: number;
  movements: TestMovement[];
};

export function norma43Statement(
  accounts: TestAccount[],
  { recordCount, newline = "\r\n" }: { recordCount?: number; newline?: string } = {},
) {
  const lines = accounts.flatMap((account) => accountRecords(account));
  lines.push(record(`88${"9".repeat(18)}${pad(recordCount ?? lines.length, 6)}`));
  return lines.join(newline) + newline;
}

function accountRecords({
  bank = "2100",
  branch = "0418",
  account = "0200051332",
  holder = "CORAL DATA LAB SL",
  start = "260901",
  end = "260930",
  openingCents = 100_000,
  closingCents,
  debitCount,
  movements,
}: TestAccount) {
  const debits = movements.filter(({ cents }) => cents < 0);
  const credits = movements.filter(({ cents }) => cents >= 0);
  const debitTotal = -debits.reduce((total, { cents }) => total + cents, 0);
  const creditTotal = credits.reduce((total, { cents }) => total + cents, 0);
  const closing = closingCents ?? openingCents + creditTotal - debitTotal;
  return [
    record(`11${bank}${branch}${account}${start}${end}${signed(openingCents)}9783${holder.padEnd(26)}`),
    ...movements.flatMap((movement) => [
      record(
        `22    ${branch}${movement.date ?? "260905"}${movement.valueDate ?? movement.date ?? "260905"}` +
          `${movement.commonConcept ?? "04"}${movement.ownConcept ?? "001"}${signed(movement.cents)}` +
          `${(movement.document ?? "0000000000").padEnd(10)}${(movement.reference1 ?? "").padEnd(12)}` +
          `${(movement.reference2 ?? "").padEnd(16)}`,
      ),
      ...(movement.concepts ?? []).map((concept, index) =>
        record(`23${pad(index + 1, 2)}${concept.slice(0, 38).padEnd(38)}${concept.slice(38, 76)}`),
      ),
    ]),
    record(
      `33${bank}${branch}${account}${pad(debitCount ?? debits.length, 5)}${pad(debitTotal, 14)}` +
        `${pad(credits.length, 5)}${pad(creditTotal, 14)}${signed(closing)}978`,
    ),
  ];
}

function signed(cents: number) {
  return `${cents < 0 ? "1" : "2"}${pad(Math.abs(cents), 14)}`;
}

function pad(value: number, length: number) {
  return String(value).padStart(length, "0");
}

function record(text: string) {
  if (text.length > 80) throw new Error(`Test record is longer than 80 characters: ${text}`);
  return text.padEnd(80);
}
