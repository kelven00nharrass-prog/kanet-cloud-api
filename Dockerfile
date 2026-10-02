FROM node:20-bullseye-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=7860 \
    MASTER_TOKEN=KaNetKelven2026Secure \
    FIREBASE_DATABASE_URL=https://ka-net-math.firebaseio.com

# Copiar arquivos de dependência e instalar
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copiar código-fonte da Cloud API
COPY . .

# Expor a porta 7860 exigida pelo Hugging Face
EXPOSE 7860 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:7860/health || exit 1

CMD ["node", "server.js"]
