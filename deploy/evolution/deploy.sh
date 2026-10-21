#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker não encontrado. Instale Docker Engine e o plugin Compose antes de continuar."
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  api_key="$(openssl rand -hex 32)"
  db_password="$(openssl rand -hex 24)"
  sed -i "s/SUBSTITUA_POR_64_CARACTERES_HEXADECIMAIS/${api_key}/" .env
  sed -i "s/SUBSTITUA_POR_UMA_SENHA_FORTE/${db_password}/" .env
  chmod 600 .env
  echo "Arquivo .env seguro criado. Confirme EVOLUTION_DOMAIN antes de continuar."
  exit 2
fi

if grep -q 'SUBSTITUA_' .env; then
  echo "O arquivo .env ainda contém valores de exemplo."
  exit 1
fi

docker compose pull
docker compose up -d
docker compose ps

echo "Evolution iniciada. Aguarde o HTTPS e teste: https://$(grep '^EVOLUTION_DOMAIN=' .env | cut -d= -f2)/"
