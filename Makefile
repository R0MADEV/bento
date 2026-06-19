SHELL := /bin/bash
UNAME := $(shell uname -s)

ifeq ($(UNAME), Darwin)
  XDISPLAY := host.docker.internal:0
else
  XDISPLAY := $(DISPLAY)
endif

.PHONY: dev dev-native build shell setup test

# Arranca el entorno de desarrollo en Docker con GUI
dev:
	@bash scripts/setup-display.sh
	DISPLAY=$(XDISPLAY) docker-compose run --rm bento \
		sh -c 'dbus-run-session -- npm run tauri:dev'

# Arranca nativo en el host (requiere Rust + Node).
# Necesario para probar el terminal: WebKit2GTK en Docker no enruta
# el teclado a xterm.js, pero el WebView nativo (WKWebView/WebView2) sí.
dev-native:
	npm run tauri:dev

# Genera los binarios para distribución
build:
	docker-compose run --rm bento npm run tauri:build

# Abre una shell interactiva dentro del contenedor
shell:
	docker-compose run --rm bento sh

# Ejecuta los tests
test:
	npm test

# Construye la imagen Docker (primera vez o tras cambiar Dockerfile)
setup:
	docker-compose build
