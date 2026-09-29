"use client";

import { useRef, useState, type FormEvent } from "react";
import { formatMoney } from "@/lib/catalog";
import { todayIso } from "@/lib/invoices";
import { journalMoneyCents, manualEntrySchema, type Account, type JournalEntry } from "@/lib/accounting";

type DraftLine = { key: number; accountId: string; debit: string; credit: string };
let nextLineKey = 0;
const emptyLines = (): DraftLine[] => [
  { key: ++nextLineKey, accountId: "", debit: "", credit: "" },
  { key: ++nextLineKey, accountId: "", debit: "", credit: "" },
];

export function ManualEntryForm({ accounts, onSaved }: { accounts: Account[]; onSaved(date: string): Promise<void> }) {
  const [entryDate, setEntryDate] = useState(todayIso);
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState(emptyLines);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState<string>();
  // Reuse the same key after an uncertain response; only an edit creates a new attempt.
  const attemptKey = useRef<string | null>(null);
  const activeAccounts = accounts.filter((account) => account.active);
  const invalidMoney = lines.some((line) => journalMoneyCents(line.debit) === null || journalMoneyCents(line.credit) === null);
  const debitCents = lines.reduce((sum, line) => sum + (journalMoneyCents(line.debit) ?? 0), 0);
  const creditCents = lines.reduce((sum, line) => sum + (journalMoneyCents(line.credit) ?? 0), 0);

  function changed() {
    attemptKey.current = null;
    setConfirmed(false);
    setSuccess(undefined);
    setError(undefined);
  }
  function updateLine(key: number, change: Partial<DraftLine>) {
    changed();
    setLines((current) => current.map((line) => line.key === key ? { ...line, ...change } : line));
  }
  function prepareContribution() {
    const bank = activeAccounts.find((account) => account.code === "572000");
    const equity = activeAccounts.find((account) => account.code === "118000");
    if (!bank || !equity) {
      setError("Se necesitan las cuentas activas 572 y 118.");
      return;
    }
    changed();
    setDescription("Aportación no reintegrable del socio · justificante: ");
    setLines([
      { key: ++nextLineKey, accountId: bank.id, debit: "", credit: "" },
      { key: ++nextLineKey, accountId: equity.id, debit: "", credit: "" },
    ]);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (invalidMoney) {
      setError("Usa importes como 367,79 o 367.79, sin separadores de miles y con dos decimales como máximo.");
      return;
    }
    const parsed = manualEntrySchema.safeParse({
      entryDate, description,
      lines: lines.map((line) => ({ accountId: line.accountId, debit: (journalMoneyCents(line.debit) ?? 0) / 100, credit: (journalMoneyCents(line.credit) ?? 0) / 100 })),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Revisa el asiento.");
      return;
    }
    if (!confirmed) {
      setError("Confirma la revisión del asiento antes de guardarlo.");
      return;
    }
    attemptKey.current ??= crypto.randomUUID();
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch("/api/accounting/entries", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...parsed.data, idempotencyKey: attemptKey.current }),
      });
      const body = await response.json() as JournalEntry & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "No se pudo guardar el asiento.");
      const savedDate = entryDate;
      attemptKey.current = null;
      setDescription("");
      setLines(emptyLines());
      setConfirmed(false);
      setSuccess(`Asiento #${body.entryNumber} guardado. Consulta el diario y el mayor para verificarlo.`);
      try {
        await onSaved(savedDate);
      } catch {
        setError("El asiento se guardó, pero no se actualizó el diario. Recarga la página; no lo vuelvas a registrar.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No se pudo confirmar el asiento; vuelve a intentarlo sin modificarlo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="data-panel accounting-panel manual-entry-panel" aria-labelledby="manual-entry-title">
      <div className="data-toolbar"><div><h2 id="manual-entry-title">Asiento manual</h2>
        <p>Para aportaciones y ajustes documentados; nunca sustituye a una factura ni mueve dinero por sí mismo.</p></div>
        <button className="secondary-button" disabled={pending} onClick={prepareContribution} type="button">Preparar aportación del socio (572 / 118)</button>
      </div>
      <form className="invoice-form" onSubmit={(event) => void submit(event)}>
        <div className="contact-form">
          <label className="field"><span>Fecha del asiento</span><input required type="date" value={entryDate} disabled={pending} onChange={(event) => { changed(); setEntryDate(event.target.value); }} /></label>
          <label className="field"><span>Concepto y referencia del justificante</span><input required maxLength={1000} value={description} disabled={pending} onChange={(event) => { changed(); setDescription(event.target.value); }} placeholder="Aportación no reintegrable · transferencia…" /></label>
        </div>
        <div className="manual-entry-lines">
          {lines.map((line, index) => <div className="manual-entry-line" key={line.key}>
            <label className="field"><span>Cuenta · línea {index + 1}</span><select required value={line.accountId} disabled={pending} onChange={(event) => updateLine(line.key, { accountId: event.target.value })}>
              <option value="">Selecciona cuenta</option>{activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}
            </select></label>
            <label className="field"><span>Debe (€)</span><input type="text" inputMode="decimal" autoComplete="off" placeholder="0,00" value={line.debit} disabled={pending} onChange={(event) => updateLine(line.key, { debit: event.target.value })} /></label>
            <label className="field"><span>Haber (€)</span><input type="text" inputMode="decimal" autoComplete="off" placeholder="0,00" value={line.credit} disabled={pending} onChange={(event) => updateLine(line.key, { credit: event.target.value })} /></label>
            <button className="text-button" disabled={pending || lines.length <= 2} onClick={() => { changed(); setLines((current) => current.filter((item) => item.key !== line.key)); }} type="button" aria-label={`Quitar línea ${index + 1}`}>Quitar</button>
          </div>)}
        </div>
        <button className="secondary-button" disabled={pending || lines.length >= 500} onClick={() => { changed(); setLines((current) => [...current, { key: ++nextLineKey, accountId: "", debit: "", credit: "" }]); }} type="button">Añadir línea</button>
        <p role="status">{invalidMoney ? "Revisa el formato de los importes (ejemplo: 367,79)." : <>Debe: {formatMoney((debitCents / 100).toFixed(2), "EUR")} · Haber: {formatMoney((creditCents / 100).toFixed(2), "EUR")} · Diferencia: {formatMoney((Math.abs(debitCents - creditCents) / 100).toFixed(2), "EUR")}</>}</p>
        <label className="check-field"><input checked={confirmed} disabled={pending} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" /><span>He comprobado el justificante y que este asiento no esté ya registrado. Los asientos contabilizados se corrigen mediante reversión, no edición.</span></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {success && <p className="form-success" role="status">{success}</p>}
        <div className="dialog-actions"><button className="primary-button compact" disabled={pending || !activeAccounts.length} type="submit">{pending ? "Guardando…" : "Guardar asiento"}</button></div>
      </form>
    </section>
  );
}
