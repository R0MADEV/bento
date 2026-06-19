FROM rust:latest

# Instalar Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs

# Instalar deps de Tauri para Linux
RUN apt-get update && apt-get install -y \
    webkit2gtk-4.1 \
    libappindicator3-1 \
    libayatana-appindicator3-1 \
    build-essential \
    libssl-dev \
    libffi-dev \
    python3 \
    pkg-config \
    && rm -rf /var/lib/apt/lists/*

# Instalar Tauri CLI
RUN npm install -g @tauri-apps/cli

# Crear directorio de trabajo
WORKDIR /bento

# Copiar archivos del proyecto
COPY . .

# Instalar deps frontend
RUN npm install

# Entrypoint: shell interactiva
ENTRYPOINT ["/bin/bash"]
