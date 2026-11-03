#!/bin/sh
# Запуск/перезапуск сервера в фоне. Аргументы передаются в serve.py (например --host 0.0.0.0).
cd "$(dirname "$0")"
pkill -f "^python3 serve.py" 2>/dev/null
setsid nohup python3 serve.py "$@" > /dev/null 2>&1 < /dev/null &
sleep 1
pgrep -f "^python3 serve.py" >/dev/null && echo "Сервер запущен: http://127.0.0.1:${PORT:-8080}/" || echo "Не удалось запустить"
