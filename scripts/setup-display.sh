#!/usr/bin/env bash
set -e

OS="$(uname -s)"

setup_macos() {
  if ! command -v xquartz &>/dev/null && ! [ -d "/Applications/Utilities/XQuartz.app" ]; then
    echo "XQuartz no encontrado. Instalando..."
    brew install --cask xquartz
    echo ""
    echo "XQuartz instalado. Pasos necesarios:"
    echo "  1. Abre XQuartz (ya se abrirá)"
    echo "  2. Ve a Preferencias → Security"
    echo "  3. Activa 'Allow connections from network clients'"
    echo "  4. Reinicia XQuartz"
    echo "  5. Vuelve a ejecutar: make dev"
    open -a XQuartz
    exit 0
  fi

  if ! pgrep -x Xquartz &>/dev/null && ! pgrep -x "XQuartz" &>/dev/null; then
    echo "Arrancando XQuartz..."
    open -a XQuartz
    sleep 3
  fi

  xhost +127.0.0.1 &>/dev/null || true
  export DISPLAY=host.docker.internal:0
}

setup_linux() {
  if [ -z "$DISPLAY" ]; then
    export DISPLAY=:0
  fi
  xhost +local:docker &>/dev/null || true
}

case "$OS" in
  Darwin) setup_macos ;;
  Linux)  setup_linux ;;
  MINGW*|MSYS*|CYGWIN*)
    echo ""
    echo "Windows detectado."
    echo "Para mostrar la ventana Bento necesitas VcXsrv:"
    echo "  1. Descarga e instala VcXsrv: https://sourceforge.net/projects/vcxsrv/"
    echo "  2. Lánzalo con XLaunch:"
    echo "     - Multiple windows"
    echo "     - Start no client"
    echo "     - Activa 'Disable access control'"
    echo "  3. Ejecuta en PowerShell:"
    echo '     $env:DISPLAY = "host.docker.internal:0"'
    echo "     docker-compose run --rm bento sh -c 'dbus-run-session -- npm run tauri:dev'"
    exit 0
    ;;
esac

echo "Display configurado: $DISPLAY"
