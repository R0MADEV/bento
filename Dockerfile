FROM ubuntu:24.04

# Instalar dependencias base
RUN apt-get update && apt-get install -y \
    build-essential \
    curl \
    wget \
    git \
    pkg-config \
    libssl-dev \
    libffi-dev \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Instalar Rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Instalar Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Habilitar universe para GStreamer codecs
RUN apt-get update && apt-get install -y software-properties-common pulseaudio-utils \
    && add-apt-repository universe \
    && rm -rf /var/lib/apt/lists/*

# Instalar deps de Tauri para Linux + dbus + Mesa
RUN apt-get update && apt-get install -y \
    webkit2gtk-4.1 \
    libayatana-appindicator3-1 \
    dbus-x11 \
    at-spi2-core \
    libgl1-mesa-dri \
    mesa-utils \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-plugins-bad \
    gstreamer1.0-tools \
    && rm -rf /var/lib/apt/lists/*

# GStreamer codecs opcionales (fallan silenciosamente si no están disponibles)
RUN apt-get update && \
    apt-get install -y gstreamer1.0-libav 2>/dev/null || true && \
    apt-get install -y gstreamer1.0-plugins-ugly 2>/dev/null || true && \
    rm -rf /var/lib/apt/lists/*

# Instalar Tauri CLI
RUN npm install -g @tauri-apps/cli

# Crear directorio de trabajo
WORKDIR /bento

# Instalar deps frontend (sin copiar el código aún)
COPY package.json package-lock.json* ./
RUN npm install

# Copiar el resto del código
COPY . .

# Sin entrypoint — docker-compose pasará los comandos directamente
