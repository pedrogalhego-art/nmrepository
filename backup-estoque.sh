#!/usr/bin/env bash
# backup-estoque.sh — baixa o backup do banco do Render e commita no GitHub
# Uso: rode manualmente ou via agendador (Windows Task Scheduler)
set -e
cd "$(dirname "$0")"

LOG=backup.log

# Senha do admin vem do .env se existir
if [ -f .env ]; then
  set -a; source .env; set +a
fi
ADMIN_PASS="${ADMIN_PASSWORD:-admin123}"

COOKIE=$(mktemp)
LOGIN=$(curl --noproxy '*' -s --max-time 90 -c "$COOKIE" -X POST \
  "https://boletim-diario-estaleiro.onrender.com/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_PASS\"}")

if ! echo "$LOGIN" | grep -q '"user"'; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Falha no login do Render" >> "$LOG"
  rm -f "$COOKIE"
  exit 1
fi

curl --noproxy '*' -s --max-time 90 -b "$COOKIE" \
  "https://boletim-diario-estaleiro.onrender.com/api/backup/download" \
  -o db_backup.json.tmp
rm -f "$COOKIE"

if ! python -c "import json; json.load(open('db_backup.json.tmp',encoding='utf-8'))" 2>/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup inválido" >> "$LOG"
  rm -f db_backup.json.tmp
  exit 1
fi

mv db_backup.json.tmp db_backup.json
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup baixado: $(wc -c < db_backup.json) bytes" >> "$LOG"

# Commit e push se mudou
git add db_backup.json
if git diff --cached --quiet; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sem mudanças" >> "$LOG"
else
  git commit -m "chore: backup automatico do banco ($(date '+%Y-%m-%d %H:%M'))" >> "$LOG" 2>&1
  git push origin main >> "$LOG" 2>&1
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup commitado e enviado" >> "$LOG"
fi