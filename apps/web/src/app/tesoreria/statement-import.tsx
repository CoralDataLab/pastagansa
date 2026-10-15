"use client";

import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type {
  BankAccount,
  StatementAccountPreview,
  StatementImportResult,
  StatementMovement,
  StatementPreview,
  TableInspection,
  TableMapping,
} from "@/lib/banking";
import {
  completeMapping,
  isNorma43,
  maskedIban,
  tableColumns,
  translateRowError,
} from "@/lib/banking";
import { formatMoney } from "@/lib/catalog";
import { formatInvoiceDate } from "@/lib/invoices";

type StatementRequest = {
  file: File;
  bankAccountId?: string;
  fileSha256?: string;
  mapping?: TableMapping;
  delimiter?: string;
};

const movementLabels: Record<StatementMovement["status"], string> = {
  NEW: "Nuevo",
  DUPLICATE: "Ya importado",
  SKIPPED: "Omitido (importe cero)",
};
const PREVIEW_ROWS = 50;
const DELIMITERS: Array<[string, string]> = [
  [";", "Punto y coma (;)"],
  [",", "Coma (,)"],
  ["\t", "Tabulador"],
  ["|", "Barra vertical (|)"],
];

/** Norma 43, CSV or Excel statement: preview against imported movements, then import the new ones. */
export function StatementImport({
  accounts,
  defaultAccountId,
  onImported,
}: {
  accounts: BankAccount[];
  defaultAccountId: string;
  onImported: (result: StatementImportResult) => Promise<void>;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<"NORMA43" | "TABLE" | null>(null);
  // Norma 43: an account without IBAN chosen for a statement that matches none.
  const [targetId, setTargetId] = useState("");
  // CSV and Excel carry no IBAN, so the user picks the account.
  const [tableAccountId, setTableAccountId] = useState("");
  const [inspection, setInspection] = useState<TableInspection | null>(null);
  const [mapping, setMapping] = useState<TableMapping | null>(null);
  const [previewedMapping, setPreviewedMapping] = useState("");
  // Kept while a new preview runs, so the table does not flicker.
  const [statement, setStatement] = useState<StatementPreview | null>(null);
  const accountId = tableAccountId || defaultAccountId;

  const preview = useMutation({
    mutationFn: (input: StatementRequest) =>
      send<StatementPreview>(input.mapping ? "table/preview" : "norma43/preview", input),
    onSuccess: (result, input) => {
      setStatement(result);
      setPreviewedMapping(input.mapping ? JSON.stringify(input.mapping) : "");
    },
  });
  const inspect = useMutation({
    mutationFn: (input: StatementRequest) => send<TableInspection>("table/inspect", input),
    onSuccess: (result, input) => {
      setInspection(result);
      setMapping(result.mapping);
      setStatement(null);
      if (completeMapping(result.mapping))
        preview.mutate({ ...input, delimiter: undefined, mapping: result.mapping });
    },
  });
  const confirm = useMutation({
    mutationFn: (input: StatementRequest) =>
      send<StatementImportResult>(input.mapping ? "table/import" : "norma43/import", input),
    onSuccess: async (result) => {
      clear();
      setFile(null);
      setKind(null);
      form.current?.reset();
      await onImported(result);
    },
  });

  function clear() {
    setTargetId("");
    setInspection(null);
    setMapping(null);
    setStatement(null);
    setPreviewedMapping("");
    preview.reset();
    inspect.reset();
    confirm.reset();
  }

  const unlinked = statement?.accounts.some((account) => !account.bankAccount);
  const newCount =
    statement?.accounts.reduce((total, account) => total + account.newCount, 0) ?? 0;
  const errorCount = statement?.errorCount ?? 0;
  const staleMapping =
    kind === "TABLE" && mapping !== null && JSON.stringify(mapping) !== previewedMapping;
  const withoutIban = accounts.filter((account) => !account.iban);
  const canChooseTarget =
    kind === "NORMA43" &&
    statement?.accounts.length === 1 &&
    withoutIban.length > 0 &&
    (unlinked || Boolean(targetId));
  const error = inspect.error ?? preview.error;

  return (
    <details className="bank-import">
      <summary>Importar extracto bancario (Norma 43, CSV o Excel)</summary>
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          if (kind === "TABLE") inspect.mutate({ file, bankAccountId: accountId });
          else preview.mutate({ file, bankAccountId: targetId || undefined });
        }}
      >
        <label className="field wide">
          <span>Fichero del banco</span>
          <input
            name="file"
            type="file"
            required
            // A finishing import clears the panel, so no new file meanwhile.
            disabled={confirm.isPending}
            onChange={async (event) => {
              const chosen = event.target.files?.[0] ?? null;
              clear();
              setFile(chosen);
              setKind(
                chosen
                  ? isNorma43(await chosen.slice(0, 64).text())
                    ? "NORMA43"
                    : "TABLE"
                  : null,
              );
            }}
          />
        </label>
        {kind === "TABLE" && (
          <label className="field">
            <span>Importar en la cuenta</span>
            <select
              value={accountId}
              onChange={(event) => {
                setTableAccountId(event.target.value);
                clear();
              }}
            >
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {maskedIban(account.iban)}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && (
          <p className="form-error wide" role="alert">
            {error.message}
          </p>
        )}
        <button
          className="primary-button compact"
          disabled={!file || !kind || inspect.isPending || preview.isPending}
        >
          {inspect.isPending || preview.isPending ? "Revisando…" : "Revisar extracto"}
        </button>
      </form>
      {file && inspection && mapping && (
        <MappingForm
          inspection={inspection}
          mapping={mapping}
          pending={preview.isPending || inspect.isPending}
          onChange={setMapping}
          onDelimiter={(delimiter) =>
            inspect.mutate({ file, bankAccountId: accountId, delimiter })
          }
          onPreview={() => preview.mutate({ file, bankAccountId: accountId, mapping })}
        />
      )}
      {statement && file && (
        <>
          {statement.accounts.map((account) => (
            <StatementAccount
              key={`${account.iban}-${account.startDate}`}
              account={account}
            />
          ))}
          {errorCount > 0 && (
            <div className="form-error" role="alert">
              <p>
                {errorCount} {errorCount === 1 ? "fila tiene" : "filas tienen"} errores.
                Corrige el fichero o las columnas elegidas:
              </p>
              <ul>
                {statement.errors?.map((rowError) => (
                  <li key={rowError.row}>
                    Fila {rowError.row}: {translateRowError(rowError.message)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Boolean(statement.ignoredCount) && (
            <p className="dialog-helper">
              {statement.ignoredCount}{" "}
              {statement.ignoredCount === 1 ? "fila sin fecha se ignora" : "filas sin fecha se ignoran"}{" "}
              (títulos, totales o saldos).
            </p>
          )}
          <div className="dialog-actions">
            {canChooseTarget && (
              <label className="field">
                <span>Importar en la cuenta</span>
                <select
                  value={targetId}
                  onChange={(event) => {
                    setTargetId(event.target.value);
                    preview.mutate({
                      file,
                      bankAccountId: event.target.value || undefined,
                    });
                  }}
                >
                  <option value="">Selecciona una cuenta sin IBAN</option>
                  {withoutIban.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {confirm.error && (
              <p className="form-error" role="alert">
                {confirm.error.message}
              </p>
            )}
            <button
              className="primary-button compact"
              disabled={
                unlinked ||
                newCount === 0 ||
                errorCount > 0 ||
                staleMapping ||
                preview.isPending ||
                confirm.isPending
              }
              onClick={() =>
                confirm.mutate(
                  kind === "TABLE" && mapping
                    ? { file, fileSha256: statement.fileSha256, bankAccountId: accountId, mapping }
                    : { file, fileSha256: statement.fileSha256, bankAccountId: targetId || undefined },
                )
              }
            >
              {confirm.isPending
                ? "Importando…"
                : staleMapping
                  ? "Actualiza la vista previa"
                  : newCount === 0
                    ? "No hay movimientos nuevos"
                    : `Importar ${newCount} ${newCount === 1 ? "movimiento" : "movimientos"}`}
            </button>
          </div>
        </>
      )}
    </details>
  );
}

const mappingColumns = [
  "dateColumn",
  "valueDateColumn",
  "amountColumn",
  "debitColumn",
  "creditColumn",
  "referenceColumn",
  "counterpartyColumn",
] as const;
type MappingColumn = (typeof mappingColumns)[number];

/** Column choices for a CSV or Excel statement; each option shows the first row's value. */
function MappingForm({
  inspection,
  mapping,
  pending,
  onChange,
  onDelimiter,
  onPreview,
}: {
  inspection: TableInspection;
  mapping: TableMapping;
  pending: boolean;
  onChange: (mapping: TableMapping) => void;
  onDelimiter: (delimiter: string) => void;
  onPreview: () => void;
}) {
  const columns = tableColumns(inspection.rows[mapping.headerRow]);
  const sample = inspection.rows[mapping.headerRow + 1] ?? [];
  const set = (patch: Partial<TableMapping>) => onChange({ ...mapping, ...patch });
  const [description, extraDescription] = mapping.descriptionColumns;
  const columnSelect = (
    label: string,
    value: string | undefined,
    onSelect: (value: string | undefined) => void,
    optional = false,
  ) => (
    <label className="field">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(event) => onSelect(event.target.value || undefined)}>
        <option value="">{optional ? "No usar" : "Selecciona una columna"}</option>
        {columns.map((name, index) => (
          <option key={name} value={name}>
            {sample[index]?.trim() ? `${short(name, 24)} — ${short(sample[index].trim(), 18)}` : short(name, 40)}
          </option>
        ))}
      </select>
    </label>
  );
  const column = (label: string, key: MappingColumn, optional = false) =>
    columnSelect(label, mapping[key], (value) => set({ [key]: value }), optional);
  return (
    <form
      aria-label="Columnas del extracto"
      onSubmit={(event) => {
        event.preventDefault();
        onPreview();
      }}
    >
      <p className="dialog-helper wide">
        {inspection.savedMapping
          ? "Usamos las columnas de la última importación en esta cuenta."
          : "Revisa las columnas que hemos reconocido."}
      </p>
      <label className="field wide">
        <span>Fila de cabecera</span>
        <select
          value={mapping.headerRow}
          onChange={(event) => {
            const headerRow = Number(event.target.value);
            const next = tableColumns(inspection.rows[headerRow]);
            const keep = (name: string | undefined) => (name && next.includes(name) ? name : undefined);
            onChange({
              ...mapping,
              headerRow,
              ...Object.fromEntries(mappingColumns.map((key) => [key, keep(mapping[key])])),
              dateColumn: keep(mapping.dateColumn) ?? "",
              descriptionColumns: mapping.descriptionColumns.filter((name) => next.includes(name)),
            });
          }}
        >
          {inspection.rows.map((row, index) => (
            <option key={index} value={index}>
              Fila {index + 1}: {short(row.filter((cell) => cell.trim()).join(" · "), 48) || "vacía"}
            </option>
          ))}
        </select>
      </label>
      {inspection.format === "CSV" && (
        <label className="field">
          <span>Separador de campos</span>
          <select value={inspection.delimiter ?? ";"} onChange={(event) => onDelimiter(event.target.value)}>
            {DELIMITERS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        <span>Separador decimal</span>
        <select
          value={mapping.decimalSeparator}
          onChange={(event) => set({ decimalSeparator: event.target.value as "," | "." })}
        >
          <option value=",">Coma (1.234,56)</option>
          <option value=".">Punto (1,234.56)</option>
        </select>
      </label>
      {column("Fecha", "dateColumn")}
      {column("Fecha valor", "valueDateColumn", true)}
      <label className="field">
        <span>Importe en</span>
        <select
          value={mapping.amountMode}
          onChange={(event) => set({ amountMode: event.target.value as TableMapping["amountMode"] })}
        >
          <option value="SIGNED">Una columna con signo</option>
          <option value="SPLIT">Columnas de cargo y abono</option>
        </select>
      </label>
      {mapping.amountMode === "SIGNED" ? (
        column("Importe", "amountColumn")
      ) : (
        <>
          {column("Cargo", "debitColumn")}
          {column("Abono", "creditColumn")}
        </>
      )}
      {columnSelect("Concepto", description, (value) =>
        set({ descriptionColumns: [value, extraDescription].filter((name): name is string => Boolean(name)) }),
      )}
      {columnSelect(
        "Concepto adicional",
        extraDescription,
        (value) => set({ descriptionColumns: [description, value].filter((name): name is string => Boolean(name)) }),
        true,
      )}
      {column("Referencia", "referenceColumn", true)}
      {column("Contraparte", "counterpartyColumn", true)}
      <button className="primary-button compact" disabled={!completeMapping(mapping) || pending}>
        {pending ? "Revisando…" : "Actualizar vista previa"}
      </button>
    </form>
  );
}

function StatementAccount({ account }: { account: StatementAccountPreview }) {
  const shown = account.movements.slice(0, PREVIEW_ROWS);
  const name = account.iban ? maskedIban(account.iban) : (account.bankAccount?.name ?? "");
  return (
    <section aria-label={`Extracto de la cuenta ${name}`}>
      <div className="data-toolbar">
        <div>
          <h2>
            {name}
            {account.holderName && ` · ${account.holderName}`}
          </h2>
          <p>
            {account.startDate && account.endDate
              ? `Del ${formatInvoiceDate(account.startDate)} al ${formatInvoiceDate(account.endDate)}`
              : "Sin movimientos con fecha"}
            {account.openingBalance !== null &&
              ` · Saldo inicial ${formatMoney(account.openingBalance, account.currency)}`}
            {account.closingBalance !== null &&
              ` · Saldo final ${formatMoney(account.closingBalance, account.currency)}`}
          </p>
        </div>
      </div>
      {account.bankAccount ? (
        <p className="dialog-helper">
          Se importará en {account.bankAccount.name}: {account.newCount} nuevos
          · {account.duplicateCount} ya importados
          {account.skippedCount > 0 &&
            ` · ${account.skippedCount} con importe cero que se omiten`}
          .
        </p>
      ) : (
        <p className="form-error" role="alert">
          Ninguna cuenta bancaria tiene el IBAN {account.iban ?? "del extracto"}.
          Créala con ese IBAN o elige una cuenta sin IBAN.
        </p>
      )}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Concepto</th>
              <th>Importe</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((movement) => {
              const detail = [movement.counterpartyName, movement.reference].filter(Boolean).join(" · ");
              return (
                <tr key={movement.externalId}>
                  <td>{formatInvoiceDate(movement.bookingDate)}</td>
                  <td>
                    {movement.description}
                    {detail && <small>{detail}</small>}
                  </td>
                  <td className="money-cell">
                    {formatMoney(movement.amount, account.currency)}
                  </td>
                  <td>{movementLabels[movement.status]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {account.movements.length > shown.length && (
        <p className="dialog-helper">
          Y {account.movements.length - shown.length} movimientos más.
        </p>
      )}
    </section>
  );
}

/** Select options size the control, so long cell texts are shortened. */
function short(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

async function send<T>(
  step: string,
  { file, bankAccountId, fileSha256, mapping, delimiter }: StatementRequest,
) {
  const body = new FormData();
  body.set("file", file, file.name);
  if (bankAccountId) body.set("bankAccountId", bankAccountId);
  if (fileSha256) body.set("fileSha256", fileSha256);
  if (mapping) body.set("mapping", JSON.stringify(mapping));
  if (delimiter) body.set("delimiter", delimiter);
  const response = await fetch(`/api/banking/statements/${step}`, { method: "POST", body });
  const json = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(json.error ?? "No se pudo completar la operación.");
  return json;
}
