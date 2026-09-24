FROM node:20-alpine AS base
WORKDIR /app

# Системные зависимости для Tesseract и PDF-обработки
RUN apk add --no-cache \
    tesseract-ocr \
    tesseract-ocr-data-rus \
    tesseract-ocr-data-eng \
    ghostscript \
    poppler-utils \
    python3 \
    make \
    g++

FROM base AS deps
COPY package.json ./
RUN npm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS production
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --frozen-lockfile

COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

RUN mkdir -p /app/uploads /app/output

EXPOSE 3001

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
