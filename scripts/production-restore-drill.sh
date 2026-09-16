#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/production-common.sh"
backup_file="${1:-}"
if [[ $# -ne 1 || ! -s "$backup_file" ]]; then
  echo "Usage: $0 BACKUP_FILE" >&2
  exit 1
fi
validate_production_environment

drill_database="pastagansa_restore_$$"
"${production_compose[@]}" exec -T postgres pg_restore --list <"$backup_file" >/dev/null
"${production_compose[@]}" exec -T postgres createdb \
  --username pastagansa_admin "$drill_database"
cleanup() {
  "${production_compose[@]}" exec -T postgres dropdb --if-exists --force \
    --username pastagansa_admin "$drill_database" >/dev/null
}
trap cleanup EXIT

"${production_compose[@]}" exec -T postgres pg_restore \
  --username pastagansa_admin --dbname "$drill_database" \
  --exit-on-error --no-owner --no-acl <"$backup_file"

live_migrations="$("${production_compose[@]}" exec -T postgres psql \
  --username pastagansa_admin --dbname pastagansa --tuples-only --no-align \
  --command='SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"
restored_migrations="$("${production_compose[@]}" exec -T postgres psql \
  --username pastagansa_admin --dbname "$drill_database" --tuples-only --no-align \
  --command='SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL')"
if [[ "$live_migrations" -eq 0 || "$live_migrations" -ne "$restored_migrations" ]]; then
  echo "Production restore drill failed: migration counts differ." >&2
  exit 1
fi

count_query="SELECT concat_ws(':',
  (SELECT count(*) FROM organizations),
  (SELECT count(*) FROM companies),
  (SELECT count(*) FROM users),
  (SELECT count(*) FROM invoices),
  (SELECT count(*) FROM sif_records),
  (SELECT count(*) FROM journal_entries),
  (SELECT count(*) FROM tax_ledger_entries)
)"
live_counts="$("${production_compose[@]}" exec -T postgres psql \
  --username pastagansa_admin --dbname pastagansa --tuples-only --no-align \
  --command="$count_query")"
restored_counts="$("${production_compose[@]}" exec -T postgres psql \
  --username pastagansa_admin --dbname "$drill_database" --tuples-only --no-align \
  --command="$count_query")"
if [[ "$live_counts" != "$restored_counts" ]]; then
  echo "Production restore drill failed: critical row counts differ." >&2
  exit 1
fi

echo "Production restore drill passed: ${restored_migrations} migrations, matching critical row counts (${restored_counts})."
