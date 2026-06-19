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

# Instalar deps de Tauri para Linux
RUN apt-get update && apt-get install -y \
    webkit2gtk-4.1 \
    libayatana-appindicator3-1 \
    && rm -rf /var/lib/apt/lists/*

# Instalar Tauri CLI
RUN npm install -g @tauri-apps/cli

# Crear directorio de trabajo
WORKDIR /bento

# Instalar deps frontend (sin copiar el código aún)
COPY package.json package-lock.json* ./
RUN npm install

# Copiar el resto del código
COPY . .

# Entrypoint: shell interactiva
ENTRYPOINT ["/bin/sh"]
