INSERT INTO "tax_rules" (
  "jurisdiction", "code", "tax_family", "operation_type", "rate",
  "subject", "exempt", "reverse_charge", "deduction_right", "intra_eu",
  "legal_reference", "effective_from"
) VALUES (
  'ES', 'ES_EU_SERVICE_REVERSE_21', 'VAT', 'INTRA_EU_SERVICE_RECEIVED', 21,
  true, false, true, true, true,
  'Ley 37/1992, arts. 69.Uno.1 y 84.Uno.2.a; https://www.boe.es/buscar/act.php?id=BOE-A-1992-28740',
  '2026-01-01'
);
