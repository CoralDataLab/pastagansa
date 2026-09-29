"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell, type SessionView } from "@/components/app-shell";
import { ManualEntryForm } from "./manual-entry-form";
import { formatMoney } from "@/lib/catalog";
import { formatInvoiceDate, todayIso } from "@/lib/invoices";
import {
  accountingDescription,
  journalSourceLabel,
  type Account,
  type GeneralLedger,
  type JournalEntry,
  type JournalPage,
} from "@/lib/accounting";

export function AccountingView() {
  const queryClient = useQueryClient();
  const today = todayIso();
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [accountId, setAccountId] = useState("");
  const entries = useQuery({
    queryKey: ["journal", from, to],
    queryFn: () =>
      requestJson<JournalPage>(
        `/api/accounting/entries?from=${from}&to=${to}&limit=100`,
      ),
  });
  const accounts = useQuery({
    queryKey: ["accounting-accounts"],
    queryFn: () => requestJson<Account[]>("/api/accounting/accounts"),
  });
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => requestJson<SessionView>("/api/auth/session"),
  });
  const ledger = useQuery({
    queryKey: ["general-ledger", accountId, from, to],
    queryFn: () =>
      requestJson<GeneralLedger>(
        `/api/accounting/general-ledger?accountId=${accountId}&from=${from}&to=${to}`,
      ),
    enabled: Boolean(accountId),
  });
  return (
    <AppShell active="contabilidad">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Contabilidad · Consulta</p>
          <h1>Diario y mayor</h1>
          <p>
            Comprueba los asientos automáticos generados por ventas, compras y
            tesorería.
          </p>
        </div>
      </section>
      <section className="accounting-filters" aria-label="Periodo contable">
        <label className="field">
          <span>Desde</span>
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Hasta</span>
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label className="field account-filter">
          <span>Cuenta para el mayor</span>
          <select
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">Selecciona una cuenta</option>
            {accounts.data
              ?.filter((account) => account.active)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
          </select>
        </label>
      </section>
      {session.data?.membership.role.permissions.includes("journal_entry.create") && (
        <ManualEntryForm accounts={accounts.data ?? []} onSaved={async (date) => {
          if (date < from) setFrom(date);
          if (date > to) setTo(date);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ["journal"] }),
            queryClient.invalidateQueries({ queryKey: ["general-ledger"] }),
          ]);
        }} />
      )}
      <section
        className="data-panel accounting-panel"
        aria-labelledby="journal-title"
      >
        <div className="data-toolbar">
          <div>
            <h2 id="journal-title">Libro diario</h2>
            <p>
              {entries.data
                ? `${entries.data.data.length} asientos en el periodo`
                : "Cargando…"}
            </p>
          </div>
        </div>
        {entries.error && <ErrorState message={entries.error.message} />}
        {entries.isPending && <p className="dialog-helper">Cargando diario…</p>}
        {entries.data?.data.length === 0 && (
          <div className="empty-state">
            <span>LD</span>
            <h3>Sin asientos en este periodo</h3>
            <p>
              Emite una venta o aprueba una compra para generar movimientos.
            </p>
          </div>
        )}
        {!!entries.data?.data.length && (
          <div className="journal-list">
            {entries.data.data.map((entry) => (
              <JournalCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </section>
      <section
        className="data-panel accounting-panel"
        aria-labelledby="ledger-title"
      >
        <div className="data-toolbar">
          <div>
            <h2 id="ledger-title">Libro mayor</h2>
            <p>
              {ledger.data
                ? `${ledger.data.account.code} · ${ledger.data.account.name}`
                : "Selecciona una cuenta para consultar sus movimientos"}
            </p>
          </div>
        </div>
        {ledger.error && <ErrorState message={ledger.error.message} />}
        {ledger.isPending && accountId && (
          <p className="dialog-helper">Cargando mayor…</p>
        )}
        {ledger.data && (
          <>
            <div className="ledger-summary">
              <span>
                Saldo inicial{" "}
                <strong>
                  {formatMoney(ledger.data.openingBalance, "EUR")}
                </strong>
              </span>
              <span>
                Debe{" "}
                <strong>{formatMoney(ledger.data.totalDebit, "EUR")}</strong>
              </span>
              <span>
                Haber{" "}
                <strong>{formatMoney(ledger.data.totalCredit, "EUR")}</strong>
              </span>
              <span>
                Saldo final{" "}
                <strong>
                  {formatMoney(ledger.data.closingBalance, "EUR")}
                </strong>
              </span>
            </div>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Asiento</th>
                    <th>Fecha</th>
                    <th>Descripción</th>
                    <th>Debe</th>
                    <th>Haber</th>
                    <th>Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.data.lines.map((line) => (
                    <tr key={line.id}>
                      <td>#{line.entryNumber}</td>
                      <td>{formatInvoiceDate(line.entryDate)}</td>
                      <td>{accountingDescription(line.description)}</td>
                      <td className="money-cell">
                        {formatMoney(line.debit, "EUR")}
                      </td>
                      <td className="money-cell">
                        {formatMoney(line.credit, "EUR")}
                      </td>
                      <td className="money-cell">
                        {formatMoney(line.runningBalance, "EUR")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </AppShell>
  );
}

function JournalCard({ entry }: { entry: JournalEntry }) {
  const debit = entry.lines.reduce((sum, line) => sum + Number(line.debit), 0);
  const credit = entry.lines.reduce(
    (sum, line) => sum + Number(line.credit),
    0,
  );
  return (
    <article>
      <header>
        <div>
          <strong>Asiento #{entry.entryNumber}</strong>
          <small>
            {formatInvoiceDate(entry.entryDate)} ·{" "}
            {journalSourceLabel(entry.sourceType)}
          </small>
        </div>
        <span>{accountingDescription(entry.description)}</span>
      </header>
      <div className="journal-totals">
        <span>
          Debe <strong>{formatMoney(String(debit), "EUR")}</strong>
        </span>
        <span>
          Haber <strong>{formatMoney(String(credit), "EUR")}</strong>
        </span>
      </div>
      <div className="journal-lines">
        {entry.lines.map((line) => (
          <div key={line.id}>
            <span>
              {line.account.code} · {line.account.name}
            </span>
            <span>
              {Number(line.debit) > 0
                ? formatMoney(line.debit, "EUR")
                : formatMoney(line.credit, "EUR")}
            </span>
          </div>
        ))}
      </div>
    </article>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="inline-error" role="alert">
      <strong>No se pudieron cargar los datos</strong>
      <p>{message}</p>
    </div>
  );
}

async function requestJson<T>(path: string) {
  const response = await fetch(path);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error ?? "No se pudo completar la consulta.");
  return body;
}
