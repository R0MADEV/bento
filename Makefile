SHELL := /bin/bash
UNAME := $(shell uname -s)

ifeq ($(UNAME), Darwin)
  XDISPLAY := host.docker.internal:0
else
  XDISPLAY := $(DISPLAY)
endif

.PHONY: dev build shell setup

# Arranca el entorno de desarrollo con GUI
dev:
	@bash scripts/setup-display.sh
	DISPLAY=$(XDISPLAY) docker-compose run --rm bento \
		sh -c 'dbus-run-session -- npm run tauri:dev'

# Genera los binarios para distribución
build:
	docker-compose run --rm bento npm run tauri:build

# Abre una shell interactiva dentro del contenedor
shell:
	docker-compose run --rm bento sh

# Construye la imagen Docker (primera vez o tras cambiar Dockerfile)
setup:
	docker-compose build
