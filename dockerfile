FROM node:22-slim

# Installe toutes les dépendances système nécessaires pour Chromium/Puppeteer
RUN apt-get update && apt-get install -y \
  chromium \
  fonts-freefont-ttf \
  libglib2.0-0 \
  libnss3 \
  libatk1.0-0 \
  libatk-bridge2.0-0 \
  libcups2 \
  libdrm2 \
  libdbus-1-3 \
  libxkbcommon0 \
  libx11-6 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxrandr2 \
  libgbm1 \
  libpango-1.0-0 \
  libcairo2 \
  libasound2 \
  libatspi2.0-0 \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

# Dit à Puppeteer d'utiliser le Chromium système et de ne pas télécharger le sien
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
