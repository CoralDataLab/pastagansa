#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/production-common.sh"
validate_production_environment

counts="$("${production_compose[@]}" exec -T postgres psql \
  --username pastagansa_admin --dbname pastagansa --tuples-only --no-align \
  --command="SELECT concat_ws(':',
    (SELECT count(*) FROM organizations),
    (SELECT count(*) FROM companies),
    (SELECT count(*) FROM users),
    (SELECT count(*) FROM invoices),
    (SELECT count(*) FROM sif_records),
    (SELECT count(*) FROM journal_entries),
    (SELECT count(*) FROM tax_ledger_entries)
  )")"
if [[ "$counts" != "0:0:0:0:0:0:0" ]]; then
  echo "Production is not empty (organizations:companies:users:invoices:SIF:journal:tax = $counts)." >&2
  echo "Do not issue real invoices until the origin of these rows is reviewed." >&2
  exit 1
fi
echo "Production database is empty of organizations, companies, users, invoices, SIF, journal, and tax entries."
