#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
environment_file="${1:-$repository_root/.env.staging}"
compose_file="$repository_root/docker-compose.staging.yml"
compose_args=(-f "$compose_file")
if [[ -n "${2:-}" ]]; then
  compose_args+=(-f "$2")
fi

if [[ ! -f "$environment_file" ]]; then
  echo "Missing staging environment file: $environment_file" >&2
  echo "Copy .env.staging.example and replace every placeholder first." >&2
  exit 1
fi

if grep -q "replace-with" "$environment_file"; then
  echo "Staging environment still contains placeholder secrets." >&2
  exit 1
fi

docker compose --env-file "$environment_file" "${compose_args[@]}" up --build -d --wait
web_port="${WEB_PORT:-$(awk -F= '$1 == "WEB_PORT" { print $2 }' "$environment_file" | tail -1)}"
web_port="${web_port:-3101}"
curl --fail --silent --show-error "http://127.0.0.1:${web_port}/acceso" >/dev/null
docker compose --env-file "$environment_file" "${compose_args[@]}" ps
echo "Staging is ready at http://127.0.0.1:${web_port}"
