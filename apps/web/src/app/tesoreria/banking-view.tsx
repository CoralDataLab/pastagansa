"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import type { Account } from "@/lib/accounting";
import type {
  BankAccount,
  BankTransaction,
  BankTransactionPage,
  ReconciliationSuggestion,
} from "@/lib/banking";
import { maskedIban } from "@/lib/banking";
import { formatMoney } from "@/lib/catalog";
import { formatInvoiceDate, todayIso } from "@/lib/invoices";

type TransactionStatus = "UNMATCHED" | "RECONCILED";

export function BankingView() {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState("");
  const [status, setStatus] = useState<TransactionStatus>("UNMATCHED");
  const [selectedId, setSelectedId] = useState("");
  const [notice, setNotice] = useState("");
  const accounts = useQuery({
    queryKey: ["bank-accounts"],
    queryFn: () => requestJson<BankAccount[]>("/api/banking/accounts"),
  });
  const ledgerAccounts = useQuery({
    queryKey: ["accounting-accounts"],
    queryFn: () => requestJson<Account[]>("/api/accounting/accounts"),
  });
  const effectiveAccountId = accountId || accounts.data?.[0]?.id || "";
  const transactions = useQuery({
    queryKey: ["bank-transactions", effectiveAccountId, status],
    queryFn: () =>
      requestJson<BankTransactionPage>(
        `/api/banking/transactions?bankAccountId=${effectiveAccountId}&status=${status}&limit=100`,
      ),
    enabled: Boolean(effectiveAccountId),
  });
  const selected = transactions.data?.data.find(
    (transaction) => transaction.id === selectedId,
  );
  const suggestions = useQuery({
    queryKey: ["bank-suggestions", selectedId],
    queryFn: () =>
      requestJson<ReconciliationSuggestion[]>(
        `/api/banking/transactions/${selectedId}/suggestions`,
      ),
    enabled: Boolean(selectedId && selected?.status === "UNMATCHED"),
  });
  const createAccount = useMutation({
    mutationFn: (payload: object) =>
      requestJson<BankAccount>("/api/banking/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: ["bank-accounts"] });
      setAccountId(account.id);
      setNotice(`${account.name} ya está lista para conciliar.`);
    },
  });
  const importTransaction = useMutation({
    mutationFn: (payload: object) =>
      requestJson<BankTransaction[]>("/api/banking/transactions/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    onSuccess: async ([transaction]) => {
      setStatus("UNMATCHED");
      await queryClient.invalidateQueries({ queryKey: ["bank-transactions"] });
      setSelectedId(transaction.id);
      setNotice("Movimiento importado. Ya puedes revisar sus coincidencias.");
    },
  });
  const reconcile = useMutation({
    mutationFn: ({
      transactionId,
      journalLineId,
    }: {
      transactionId: string;
      journalLineId: string;
    }) =>
      requestJson(`/api/banking/transactions/${transactionId}/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ journalLineId }),
      }),
    onSuccess: async () => {
      setSelectedId("");
      await queryClient.invalidateQueries({ queryKey: ["bank-transactions"] });
      setNotice("Movimiento conciliado con su apunte contable.");
    },
  });

  return (
    <AppShell active="tesoreria">
      <section className="page-heading">
        <div>
          <p className="eyebrow">Tesorería · Control</p>
          <h1>Conciliación bancaria</h1>
          <p>Importa movimientos y confirma su correspondencia contable.</p>
        </div>
      </section>
      {notice && (
        <div className="notice" role="status">
          <span>✓</span>
          {notice}
          <button onClick={() => setNotice("")} aria-label="Cerrar aviso">
            ×
          </button>
        </div>
      )}
      {accounts.error && <ErrorState message={accounts.error.message} />}
      {accounts.data?.length === 0 ? (
        <BankAccountSetup
          accounts={ledgerAccounts.data ?? []}
          pending={createAccount.isPending}
          error={createAccount.error?.message}
          onSubmit={(payload) => createAccount.mutate(payload)}
        />
      ) : (
        <>
          <section className="banking-toolbar" aria-label="Filtros bancarios">
            <label className="field">
              <span>Cuenta bancaria</span>
              <select
                value={effectiveAccountId}
                onChange={(event) => {
                  setAccountId(event.target.value);
                  setSelectedId("");
                }}
              >
                {accounts.data?.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {maskedIban(account.iban)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Estado</span>
              <select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as TransactionStatus);
                  setSelectedId("");
                }}
              >
                <option value="UNMATCHED">Por conciliar</option>
                <option value="RECONCILED">Conciliados</option>
              </select>
            </label>
          </section>
          <ImportTransaction
            accountId={effectiveAccountId}
            pending={importTransaction.isPending}
            error={importTransaction.error?.message}
            onSubmit={(payload) => importTransaction.mutate(payload)}
          />
          <section className="reconciliation-layout">
            <TransactionInbox
              loading={transactions.isPending}
              error={transactions.error?.message}
              transactions={transactions.data?.data ?? []}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
            <SuggestionPanel
              transaction={selected}
              suggestions={suggestions.data}
              loading={suggestions.isPending}
              error={suggestions.error?.message ?? reconcile.error?.message}
              pending={reconcile.isPending}
              onReconcile={(journalLineId) =>
                selected &&
                reconcile.mutate({ transactionId: selected.id, journalLineId })
              }
            />
          </section>
        </>
      )}
    </AppShell>
  );
}

function BankAccountSetup({
  accounts,
  pending,
  error,
  onSubmit,
}: {
  accounts: Account[];
  pending: boolean;
  error?: string;
  onSubmit: (payload: object) => void;
}) {
  const available = accounts.filter(
    (account) => account.active && account.isReconcilable,
  );
  return (
    <section
      className="data-panel banking-onboarding"
      aria-labelledby="bank-setup-title"
    >
      <div>
        <p className="eyebrow">Primer paso</p>
        <h2 id="bank-setup-title">Conecta tu cuenta contable de banco</h2>
        <p>
          No se solicitan credenciales bancarias. La vinculación sirve para
          comparar extracto y contabilidad.
        </p>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onSubmit({
            accountId: data.get("accountId"),
            name: data.get("name"),
            iban: data.get("iban") || undefined,
            currency: "EUR",
          });
        }}
      >
        <label className="field">
          <span>Cuenta contable</span>
          <select name="accountId" required defaultValue="">
            <option value="" disabled>
              Selecciona una cuenta
            </option>
            {available.map((account) => (
              <option key={account.id} value={account.id}>
                {account.code} · {account.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Nombre</span>
          <input
            name="name"
            required
            maxLength={240}
            placeholder="Cuenta operativa"
          />
        </label>
        <label className="field">
          <span>IBAN (opcional)</span>
          <input name="iban" maxLength={34} placeholder="ES91…" />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary-button compact"
          disabled={pending || available.length === 0}
        >
          {pending ? "Guardando…" : "Crear cuenta bancaria"}
        </button>
      </form>
    </section>
  );
}

function ImportTransaction({
  accountId,
  pending,
  error,
  onSubmit,
}: {
  accountId: string;
  pending: boolean;
  error?: string;
  onSubmit: (payload: object) => void;
}) {
  return (
    <details className="bank-import">
      <summary>Importar un movimiento manualmente</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onSubmit({
            bankAccountId: accountId,
            transactions: [
              {
                externalId: data.get("externalId"),
                bookingDate: data.get("bookingDate"),
                amount: Number(data.get("amount")),
                description: data.get("description"),
                counterpartyName: data.get("counterpartyName") || undefined,
                reference: data.get("reference") || undefined,
              },
            ],
          });
        }}
      >
        <label className="field">
          <span>Identificador único</span>
          <input
            name="externalId"
            required
            maxLength={240}
            placeholder="MOV-2026-001"
          />
        </label>
        <label className="field">
          <span>Fecha</span>
          <input
            name="bookingDate"
            type="date"
            required
            defaultValue={todayIso()}
          />
        </label>
        <label className="field">
          <span>Importe</span>
          <input
            name="amount"
            type="number"
            step="0.01"
            required
            placeholder="121,00 o -121,00"
          />
        </label>
        <label className="field">
          <span>Contraparte</span>
          <input
            name="counterpartyName"
            maxLength={240}
            placeholder="Cliente o proveedor"
          />
        </label>
        <label className="field wide">
          <span>Descripción</span>
          <input
            name="description"
            required
            maxLength={1000}
            placeholder="Transferencia factura…"
          />
        </label>
        <label className="field wide">
          <span>Referencia (opcional)</span>
          <input name="reference" maxLength={240} />
        </label>
        {error && (
          <p className="form-error wide" role="alert">
            {error}
          </p>
        )}
        <button className="primary-button compact" disabled={pending}>
          {pending ? "Importando…" : "Importar movimiento"}
        </button>
      </form>
    </details>
  );
}

function TransactionInbox({
  loading,
  error,
  transactions,
  selectedId,
  onSelect,
}: {
  loading: boolean;
  error?: string;
  transactions: BankTransaction[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="data-panel bank-inbox">
      <div className="data-toolbar">
        <div>
          <h2>Movimientos</h2>
          <p>{transactions.length} en la bandeja seleccionada</p>
        </div>
      </div>
      {loading && <p className="dialog-helper">Cargando movimientos…</p>}
      {error && <ErrorState message={error} />}
      {!loading && !error && transactions.length === 0 && (
        <div className="empty-state">
          <span>€</span>
          <h3>Bandeja al día</h3>
          <p>No hay movimientos con este estado.</p>
        </div>
      )}
      <div className="bank-transaction-list">
        {transactions.map((transaction) => (
          <button
            key={transaction.id}
            className={selectedId === transaction.id ? "selected" : ""}
            onClick={() => onSelect(transaction.id)}
          >
            <strong
              className={Number(transaction.amount) < 0 ? "negative" : ""}
            >
              {formatMoney(transaction.amount, transaction.currency)}
            </strong>
            <span>
              {transaction.counterpartyName ?? transaction.description}
            </span>
            <small>
              {formatInvoiceDate(transaction.bookingDate)} ·{" "}
              {transaction.reference ?? transaction.externalId}
            </small>
            <em>
              {transaction.status === "UNMATCHED"
                ? "Por conciliar"
                : "Conciliado"}
            </em>
          </button>
        ))}
      </div>
    </section>
  );
}

function SuggestionPanel({
  transaction,
  suggestions,
  loading,
  error,
  pending,
  onReconcile,
}: {
  transaction?: BankTransaction;
  suggestions?: ReconciliationSuggestion[];
  loading: boolean;
  error?: string;
  pending: boolean;
  onReconcile: (id: string) => void;
}) {
  return (
    <section className="data-panel suggestion-panel">
      <div className="data-toolbar">
        <div>
          <h2>Detalle y sugerencias</h2>
          <p>
            {transaction ? transaction.description : "Selecciona un movimiento"}
          </p>
        </div>
      </div>
      {!transaction && (
        <div className="empty-state">
          <span>↔</span>
          <h3>Selecciona un movimiento</h3>
          <p>Verás las coincidencias por cuenta, importe y fecha.</p>
        </div>
      )}
      {transaction?.status === "RECONCILED" && (
        <div className="empty-state">
          <span>✓</span>
          <h3>Movimiento conciliado</h3>
          <p>La relación contable queda protegida y es de solo lectura.</p>
        </div>
      )}
      {transaction?.status === "UNMATCHED" && loading && (
        <p className="dialog-helper">Buscando coincidencias…</p>
      )}
      {error && <ErrorState message={error} />}
      {transaction?.status === "UNMATCHED" && suggestions?.length === 0 && (
        <div className="empty-state">
          <span>?</span>
          <h3>Sin coincidencia exacta</h3>
          <p>
            Comprueba que el cobro o pago esté contabilizado con el mismo
            importe.
          </p>
        </div>
      )}
      {transaction?.status === "UNMATCHED" && (
        <div className="suggestion-list">
          {suggestions?.map((suggestion) => (
            <article key={suggestion.journalLineId}>
              <strong>{suggestion.score}%</strong>
              <div>
                <span>Asiento #{suggestion.entry.entryNumber}</span>
                <small>
                  {formatInvoiceDate(suggestion.entry.entryDate)} ·{" "}
                  {suggestion.entry.description}
                </small>
                <b>
                  {formatMoney(
                    Number(suggestion.debit) > 0
                      ? suggestion.debit
                      : suggestion.credit,
                    transaction?.currency ?? "EUR",
                  )}
                </b>
              </div>
              <button
                className="primary-button compact"
                disabled={pending}
                onClick={() => onReconcile(suggestion.journalLineId)}
              >
                {pending ? "Conciliando…" : "Conciliar"}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="inline-error" role="alert">
      <strong>No se pudo completar la operación</strong>
      <p>{message}</p>
    </div>
  );
}

async function requestJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new Error(body.error ?? "No se pudo completar la operación.");
  return body;
}
