#!/bin/bash

echo "Проверка и сброс старых процессов llama-server.exe..."
taskkill //F //IM llama-server.exe >/dev/null 2>&1
sleep 1

LLAMA_DIR="/z/Huggingface/llama_ai"
export PATH="$LLAMA_DIR:$PATH"

# 1. Проверяем наличие llama-server.exe в Z:\Huggingface\llama_ai
if [ ! -f "$LLAMA_DIR/llama-server.exe" ]; then
    echo "❌ Ошибка: В папке $LLAMA_DIR не найден llama-server.exe!"
    ls -lh "$LLAMA_DIR"
    exit 1
fi

# 2. Ищем модель и проектор сначала в Z:\Huggingface\llama_ai, затем в Z:\Huggingface\hub
MAIN_MODEL_PATH=$(find "$LLAMA_DIR" /z/Huggingface/hub -maxdepth 1 -name "*.gguf" ! -name "*mmproj*" 2>/dev/null | head -n 1)
MMPROJ_PATH=$(find "$LLAMA_DIR" /z/Huggingface/hub -maxdepth 1 -name "*mmproj*.gguf" 2>/dev/null | head -n 1)

if [ -z "$MAIN_MODEL_PATH" ] || [ -z "$MMPROJ_PATH" ]; then
    echo "❌ Ошибка: Не найдены файлы .gguf в $LLAMA_DIR или /z/Huggingface/hub"
    exit 1
fi

WIN_SERVER=$(cygpath -w "$LLAMA_DIR/llama-server.exe")
WIN_MAIN=$(cygpath -w "$MAIN_MODEL_PATH")
WIN_MMPROJ=$(cygpath -w "$MMPROJ_PATH")

echo "=================================================="
echo "Сервер: $WIN_SERVER"
echo "Основная модель: $WIN_MAIN"
echo "Vision-проектор: $WIN_MMPROJ"
echo "=================================================="

"$LLAMA_DIR/llama-server.exe" \
  -m "$WIN_MAIN" \
  --mmproj "$WIN_MMPROJ" \
  -c 256000 \
  -fa on \
  -ctk q8_0 \
  -ctv q8_0 \
  -ngl 20 \
  -np 1 \
  -b 1024 \
  -ub 256 \
  --jinja \
  --port 8080
