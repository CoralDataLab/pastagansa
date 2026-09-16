#!/usr/bin/env bash

production_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
production_environment_file="$production_root/.env.production"
production_compose_file="$production_root/docker-compose.production.yml"
# Shell-exported staging values must never override the production env file.
production_compose=(
  env -u COMPOSE_PROJECT_NAME
  -u POSTGRES_ADMIN_PASSWORD -u POSTGRES_APP_PASSWORD
  -u DATABASE_URL -u DIRECT_DATABASE_URL -u JWT_SECRET
  -u JWT_ISSUER -u JWT_AUDIENCE
  -u ACCESS_TOKEN_TTL_SECONDS -u REFRESH_TOKEN_TTL_DAYS
  -u THROTTLE_LIMIT -u OCR_WORKER_ENABLED
  -u SMTP_HOST -u SMTP_PORT -u SMTP_SECURE -u SMTP_USER -u SMTP_PASSWORD -u SMTP_FROM
  -u WEB_PORT
  docker compose --env-file "$production_environment_file" -f "$production_compose_file"
)

validate_production_environment() {
  if [[ ! -f "$production_environment_file" ]]; then
    echo "Missing .env.production. Copy .env.production.example and set unique production secrets." >&2
    return 1
  fi
  local permissions
  if permissions="$(stat -c %a "$production_environment_file" 2>/dev/null)"; then
    :
  else
    permissions="$(stat -f %Lp "$production_environment_file")"
  fi
  if [[ "$permissions" != 600 && "$permissions" != 400 ]]; then
    echo ".env.production must have permissions 600 or 400 (currently $permissions)." >&2
    return 1
  fi
  if grep -Eq '^[^#]*replace-with' "$production_environment_file"; then
    echo ".env.production still contains placeholder secrets." >&2
    return 1
  fi
  if grep -Eq '^(COMPOSE_PROJECT_NAME|COMPOSE_FILE)=' "$production_environment_file"; then
    echo ".env.production must not override the production Compose project or file." >&2
    return 1
  fi
  for key in DATABASE_URL DIRECT_DATABASE_URL; do
    if ! grep -Eq "^${key}=postgresql://[^[:space:]]+@postgres:5432/pastagansa\\?schema=public$" "$production_environment_file"; then
      echo "$key must use the private postgres service and pastagansa database." >&2
      return 1
    fi
  done
  docker info >/dev/null
  "${production_compose[@]}" config --quiet
}
