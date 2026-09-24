# PDF-to-Text → Web-платформа: план перехода в продакшн

> Дата составления: 2026-08-24  
> Репозиторий: `viktorbrojs-sys/pdf-to-text`  
> Текущая база: Electron-desktop, один пользователь, без auth, без БД

---

## 0. Ключевые решения (до старта)

| Вопрос | Рекомендация | Альтернатива |
|---|---|---|
| Веб-фреймворк (backend) | **Fastify** (быстрее Express, встроенная схема) | Express |
| Очередь задач | **BullMQ** (Redis-based, уже используется паттерн batch-queue) | node-rq, pg-boss |
| Auth-провайдер | **Keycloak** (AD/LDAP, OIDC, роли, SSO) | Authentik |
| БД | **PostgreSQL** (Prisma ORM) | SQLite (старт), MongoDB |
| Хранилище файлов | **MinIO** (S3-compatible, self-hosted) | локальный volume |
| Реверс-прокси | **nginx** | Traefik |
| LLM / OCR | **Ollama** (self-hosted, уже есть) + опционально OpenAI/DeepL через env |  |

---

## 1. Архитектура целевой системы

```
┌─────────────────────────────────────────────────────┐
│                     LAN / VPN                       │
│                                                     │
│  Browser  ──→  nginx (443/80)                       │
│                    │                                │
│           ┌────────┴────────┐                       │
│           │                 │                       │
│      React SPA         API Server                   │
│     (статика)         (Fastify, Node)               │
│                             │                       │
│                 ┌───────────┼───────────┐           │
│                 │           │           │           │
│            Keycloak    PostgreSQL    Redis           │
│           (OIDC/AD)    (данные,     (BullMQ)        │
│                         аудит)          │           │
│                                    Workers (OCR/    │
│                                    translate/export) │
│                                         │           │
│                                       MinIO         │
│                                  (PDF → output)     │
│                                         │           │
│                                       Ollama        │
│                                    (LLM / Vision)   │
└─────────────────────────────────────────────────────┘
```

---

## 2. Структура нового репозитория

```
pdf-to-text-web/
├── docker-compose.yml            ← оркестрация всех сервисов
├── docker-compose.dev.yml        ← override для разработки
├── .env.example
│
├── apps/
│   ├── api/                      ← Fastify backend
│   │   ├── src/
│   │   │   ├── server.ts         ← точка входа, регистрация плагинов
│   │   │   ├── plugins/
│   │   │   │   ├── auth.ts       ← Keycloak OIDC (openid-client)
│   │   │   │   ├── db.ts         ← Prisma client
│   │   │   │   ├── minio.ts      ← S3 client
│   │   │   │   └── bull.ts       ← BullMQ queues
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts       ← /auth/callback, /auth/logout
│   │   │   │   ├── documents.ts  ← CRUD документов
│   │   │   │   ├── jobs.ts       ← запуск OCR/translate, статус
│   │   │   │   ├── export.ts     ← скачать MD/DOCX/PDF
│   │   │   │   ├── admin.ts      ← пользователи, логи, настройки
│   │   │   │   └── health.ts
│   │   │   ├── workers/
│   │   │   │   ├── ocr.worker.ts
│   │   │   │   ├── translate.worker.ts
│   │   │   │   └── export.worker.ts
│   │   │   └── lib/
│   │   │       ├── ocr-ai.js     ← скопировано из scripts/ (без изменений)
│   │   │       ├── ocr-tesseract.js
│   │   │       ├── translate.js
│   │   │       ├── export.js
│   │   │       └── batch-queue.js
│   │   ├── prisma/
│   │   │   └── schema.prisma
│   │   └── Dockerfile
│   │
│   └── web/                      ← React SPA
│       ├── src/
│       │   ├── api/              ← замена window.electronAPI → fetch/WS
│       │   │   └── client.ts
│       │   ├── components/       ← OcrPanel, TranslationPanel, ExportPanel, BatchWindow ...
│       │   │                       (переносятся почти без изменений)
│       │   ├── pages/
│       │   │   ├── App.tsx
│       │   │   ├── AdminPage.tsx
│       │   │   └── LoginCallback.tsx
│       │   └── styles.css        ← без изменений
│       └── Dockerfile
│
├── infra/
│   ├── nginx/
│   │   └── nginx.conf
│   ├── keycloak/
│   │   └── realm-export.json     ← преднастроенный realm с ролями
│   └── postgres/
│       └── init.sql
```

---

## 3. База данных (Prisma schema)

```prisma
// prisma/schema.prisma

model User {
  id          String    @id @default(uuid())
  keycloakId  String    @unique
  username    String
  email       String    @unique
  department  String?
  role        Role      @default(USER)
  documents   Document[]
  auditLogs   AuditLog[]
  createdAt   DateTime  @default(now())
}

enum Role {
  USER        // загрузить PDF, запустить OCR/перевод, скачать результат
  MANAGER     // всё выше + видеть задачи своего подразделения
  ADMIN       // полный доступ + настройки системы
}

model Document {
  id          String    @id @default(uuid())
  userId      String
  user        User      @relation(fields: [userId], references: [id])
  fileName    String
  storagePath String    // MinIO key
  status      DocStatus @default(UPLOADED)
  ocrMethod   String?
  ocrText     String?
  translated  String?
  language    String?
  jobs        Job[]
  exports     Export[]
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}

enum DocStatus {
  UPLOADED
  OCR_PENDING
  OCR_DONE
  TRANSLATE_PENDING
  TRANSLATE_DONE
  EXPORT_READY
  ERROR
}

model Job {
  id          String    @id @default(uuid())
  documentId  String
  document    Document  @relation(fields: [documentId], references: [id])
  type        JobType   // OCR | TRANSLATE | EXPORT
  status      JobStatus @default(QUEUED)
  progress    Int       @default(0)
  error       String?
  createdAt   DateTime  @default(now())
  finishedAt  DateTime?
}

enum JobType   { OCR TRANSLATE EXPORT }
enum JobStatus { QUEUED RUNNING DONE FAILED }

model Export {
  id          String   @id @default(uuid())
  documentId  String
  document    Document @relation(fields: [documentId], references: [id])
  format      String   // md | docx | pdf
  storagePath String
  createdAt   DateTime @default(now())
}

model AuditLog {
  id         String   @id @default(uuid())
  userId     String?
  user       User?    @relation(fields: [userId], references: [id])
  action     String   // UPLOAD | OCR_START | TRANSLATE | EXPORT_DOWNLOAD | LOGIN | LOGOUT
  meta       Json?    // {fileName, format, ip, duration…}
  ip         String?
  createdAt  DateTime @default(now())
}

model SystemSetting {
  key        String   @id
  value      String
  updatedAt  DateTime @updatedAt
}
```

---

## 4. API (Fastify routes)

### 4.1 Auth

```
GET  /auth/login          → redirect to Keycloak
GET  /auth/callback       → OIDC callback, set httpOnly cookie с JWT
POST /auth/logout         → revoke token, clear cookie
GET  /auth/me             → текущий пользователь + роль
```

### 4.2 Документы

```
POST   /api/documents/upload         → multipart, сохраняет PDF в MinIO
GET    /api/documents                → список документов пользователя
GET    /api/documents/:id            → мета + статус
DELETE /api/documents/:id            → удалить (только свой или ADMIN)
```

### 4.3 Задачи

```
POST /api/documents/:id/ocr          → { method, model } → ставит в BullMQ
POST /api/documents/:id/translate    → { provider, targetLang, glossary }
GET  /api/jobs/:jobId                → статус + прогресс
WS   /ws/jobs/:jobId                 → live-прогресс (заменяет IPC onProgress)
```

### 4.4 Экспорт

```
POST /api/documents/:id/export       → { formats: ['md','docx','pdf'] }
GET  /api/documents/:id/exports      → список экспортов
GET  /api/exports/:exportId/download → скачать файл из MinIO
```

### 4.5 Админ (Role: ADMIN)

```
GET    /api/admin/users              → все пользователи
PATCH  /api/admin/users/:id/role     → изменить роль
GET    /api/admin/logs               → аудит-лог (фильтры: user, action, date)
GET    /api/admin/stats              → кол-во документов, jobs, ошибки
GET    /api/admin/settings           → системные настройки
PATCH  /api/admin/settings           → изменить (доступные модели, размер файла...)
GET    /api/admin/jobs               → все задачи (с фильтром по статусу)
POST   /api/admin/jobs/:id/retry     → перезапустить упавший job
```

---

## 5. Адаптация фронтенда

Компоненты переносятся **почти без изменений** — меняется только источник данных.

### 5.1 Замена `window.electronAPI` → `api/client.ts`

```typescript
// src/api/client.ts
const BASE = '/api';

export const api = {
  // Было: window.electronAPI.exportFile(text, baseName, dir, formats)
  // Стало:
  async exportFile(docId: string, formats: string[]) {
    return fetch(`${BASE}/documents/${docId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formats }),
    }).then(r => r.json());
  },

  // Было: window.electronAPI.runOCR(path, method, opts, onProgress)
  // Стало:
  startOCR(docId: string, method: string, opts: object) {
    return fetch(`${BASE}/documents/${docId}/ocr`, {
      method: 'POST',
      body: JSON.stringify({ method, ...opts }),
    }).then(r => r.json()); // возвращает { jobId }
  },

  // Живой прогресс — WebSocket вместо IPC
  watchJob(jobId: string, onProgress: (p: Progress) => void) {
    const ws = new WebSocket(`/ws/jobs/${jobId}`);
    ws.onmessage = e => onProgress(JSON.parse(e.data));
    return () => ws.close();
  },
  // ... остальные методы по аналогии
};
```

### 5.2 Что НЕ нужно переписывать

- `OcrPanel.jsx`, `TranslationPanel.jsx`, `ExportPanel.jsx` — вся логика UI остаётся
- `styles.css`, CSS-переменные тем — без изменений
- `scripts/translate.js`, `scripts/export.js`, `scripts/batch-queue.js` — переносятся в `apps/api/src/lib/` как есть (они чистый Node, без Electron)

### 5.3 Что добавить во фронтенде

- **AuthGuard** — проверяет наличие сессии, редиректит на `/auth/login`
- **AdminPage** — таблицы пользователей, аудит-лог, статистика, настройки
- **DocumentList** — список загруженных документов пользователя (новый flow: сначала загрузить PDF → потом OCR)
- **JobProgressBar** — уже есть в BatchWindow, вынести в общий компонент

---

## 6. Разграничение прав

| Действие | USER | MANAGER | ADMIN |
|---|:---:|:---:|:---:|
| Загрузить PDF | ✅ | ✅ | ✅ |
| Запустить OCR | ✅ | ✅ | ✅ |
| Перевести | ✅ | ✅ | ✅ |
| Скачать свои файлы | ✅ | ✅ | ✅ |
| Видеть документы своего отдела | ❌ | ✅ | ✅ |
| Видеть все документы | ❌ | ❌ | ✅ |
| Аудит-лог | ❌ | ❌ | ✅ |
| Управление пользователями | ❌ | ❌ | ✅ |
| Системные настройки | ❌ | ❌ | ✅ |
| Retry упавших job'ов | ❌ | ❌ | ✅ |

Роли назначаются в Keycloak и попадают в JWT claim `realm_access.roles` → Fastify middleware `requireRole('ADMIN')`.

---

## 7. Логирование и аудит

```
Уровни:
  debug  — детали обработки (только dev)
  info   — старт/конец job, логин/логаут
  warn   — медленный job, retry
  error  — упавший job, ошибка экспорта

Каналы:
  1. Файл (Winston/Pino) — ротация по дате, хранение 30 дней
  2. PostgreSQL (таблица AuditLog) — только бизнес-события:
     LOGIN | LOGOUT | UPLOAD | OCR_START | OCR_DONE | TRANSLATE |
     EXPORT_DOWNLOAD | ROLE_CHANGE | SETTINGS_CHANGE

Что пишем в каждое событие:
  { action, userId, username, ip, docId?, fileName?, format?, duration?, error? }

Доступ к логам: только ADMIN через /api/admin/logs (фильтры: user, action, dateRange)
```

---

## 8. Docker Compose

```yaml
# docker-compose.yml
version: '3.9'

services:

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./infra/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./infra/nginx/certs:/etc/nginx/certs:ro
    depends_on: [web, api]

  web:
    build: ./apps/web
    environment:
      - VITE_API_BASE=/api
    depends_on: [api]

  api:
    build: ./apps/api
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/pdftotextdb
      - REDIS_URL=redis://redis:6379
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
      - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
      - KEYCLOAK_URL=http://keycloak:8080
      - KEYCLOAK_REALM=pdf-to-text
      - KEYCLOAK_CLIENT_ID=pdf-to-text-api
      - KEYCLOAK_CLIENT_SECRET=${KEYCLOAK_CLIENT_SECRET}
      - JWT_SECRET=${JWT_SECRET}
      - OLLAMA_URL=http://ollama:11434
    depends_on:
      postgres: { condition: service_healthy }
      redis:    { condition: service_started }
      minio:    { condition: service_started }
      keycloak: { condition: service_healthy }
    volumes:
      - ./data/uploads:/app/uploads   # временные файлы до MinIO
      - ./data/output:/app/output

  worker:
    build: ./apps/api
    command: node dist/workers/index.js
    environment:
      # те же env что у api
      - DATABASE_URL=postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/pdftotextdb
      - REDIS_URL=redis://redis:6379
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY}
      - MINIO_SECRET_KEY=${MINIO_SECRET_KEY}
      - OLLAMA_URL=http://ollama:11434
    depends_on: [api]
    deploy:
      replicas: 2          # масштабируем воркеры горизонтально

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=pdftotextdb
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      - MINIO_ROOT_USER=${MINIO_ACCESS_KEY}
      - MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY}
    volumes:
      - minio_data:/data
    ports:
      - "9001:9001"   # MinIO Console (только для admin, не публичный)

  keycloak:
    image: quay.io/keycloak/keycloak:24.0
    command: start-dev --import-realm
    environment:
      - KEYCLOAK_ADMIN=admin
      - KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}
      - KC_DB=postgres
      - KC_DB_URL=jdbc:postgresql://postgres:5432/pdftotextdb
      - KC_DB_USERNAME=postgres
      - KC_DB_PASSWORD=${POSTGRES_PASSWORD}
    volumes:
      - ./infra/keycloak/realm-export.json:/opt/keycloak/data/import/realm.json:ro
    depends_on:
      postgres: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:8080/health/ready || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10

  ollama:
    image: ollama/ollama
    volumes:
      - ollama_data:/root/.ollama
    ports:
      - "11434:11434"   # внутренняя сеть только
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]   # убрать если нет GPU

volumes:
  postgres_data:
  redis_data:
  minio_data:
  ollama_data:
```

---

## 9. Этапы реализации

### Этап 1 — Backend-скелет (1–2 недели)

- [ ] Создать `apps/api` (Fastify + TypeScript)
- [ ] Настроить Prisma + PostgreSQL (`User`, `Document`, `Job`, `AuditLog`)
- [ ] Поднять Keycloak в Docker, создать realm `pdf-to-text`, клиент, роли (USER/MANAGER/ADMIN)
- [ ] OIDC-плагин Fastify: `/auth/login` → `/auth/callback` → httpOnly JWT cookie
- [ ] Middleware `requireRole()` с проверкой ролей из JWT
- [ ] Health-роут, базовые логи (Pino + файл)
- [ ] MinIO: бакет `documents`, бакет `exports`
- [ ] Роут `POST /api/documents/upload` → сохранение в MinIO

**Результат:** можно логиниться через Keycloak и загружать PDF.

---

### Этап 2 — Перенос бизнес-логики (1–2 недели)

- [ ] Скопировать `scripts/` → `apps/api/src/lib/`, убрать любые Electron-зависимости
- [ ] Настроить BullMQ (Redis): очереди `ocr`, `translate`, `export`
- [ ] Workers: `ocr.worker.ts` (вызывает lib/ocr-ai.js / ocr-tesseract.js), `translate.worker.ts`, `export.worker.ts`
- [ ] Роуты `/api/documents/:id/ocr`, `/api/documents/:id/translate`
- [ ] WebSocket `/ws/jobs/:jobId` — live-прогресс (замена IPC `onProgress`)
- [ ] Роут `/api/documents/:id/export` + download через MinIO presigned URL
- [ ] Запись в `AuditLog` для всех бизнес-событий

**Результат:** полный OCR + перевод + экспорт через API.

---

### Этап 3 — Фронтенд-адаптация (1 неделя)

- [ ] Создать `apps/web` (Vite + React, перенести все компоненты)
- [ ] Написать `src/api/client.ts` — все методы бывшего `window.electronAPI`
- [ ] `AuthGuard` + страница `LoginCallback`
- [ ] `DocumentList` — загрузка PDF, список документов с статусами
- [ ] Заменить вызовы `window.electronAPI.*` → `api.*` во всех компонентах
- [ ] WebSocket-хук `useJobProgress(jobId)` → прогресс-бар

**Результат:** приложение работает в браузере для авторизованного пользователя.

---

### Этап 4 — Админ-панель (1 неделя)

- [ ] Страница `/admin` (доступна только ADMIN)
- [ ] Вкладка «Пользователи» — список, кнопка смены роли (PATCH `/api/admin/users/:id/role`)
- [ ] Вкладка «Аудит» — таблица с фильтрами (пользователь, действие, дата)
- [ ] Вкладка «Задачи» — все jobs, статусы, кнопка retry
- [ ] Вкладка «Статистика» — документов/задач за период, ошибки, топ пользователей
- [ ] Вкладка «Настройки» — доступные OCR-методы, максимальный размер файла, список моделей Ollama

---

### Этап 5 — Docker Compose + деплой (3–5 дней)

- [ ] `Dockerfile` для `apps/api` и `apps/web`
- [ ] `docker-compose.yml` со всеми сервисами (см. п.8)
- [ ] `infra/nginx/nginx.conf` — reverse proxy, SSL termination, `/api` → api, `/` → web, `/ws` → api WS
- [ ] `infra/keycloak/realm-export.json` — realm с LDAP/AD-федерацией
- [ ] `.env.example` со всеми переменными
- [ ] `Makefile` с командами: `make up`, `make down`, `make migrate`, `make seed-admin`
- [ ] Документация `DEPLOY.md`

---

### Этап 6 — Интеграция с AD через Keycloak (2–3 дня)

В Keycloak UI (или через `realm-export.json`):
- Добавить User Federation → LDAP
- Настроить: `Connection URL`, `Bind DN`, `Users DN`, `UUID LDAP attribute`
- Маппер атрибутов: `sAMAccountName` → `username`, `mail` → `email`, `department` → `department`
- Синхронизация групп AD → роли Keycloak (USER/MANAGER/ADMIN)

---

## 10. Приоритизация рисков

| Риск | Вероятность | Митигация |
|---|---|---|
| Tesseract медленный в Docker | Высокая | воркер в отдельном контейнере, `replicas: 2` |
| Большие PDF (~100+ стр.) нагружают память | Средняя | стриминг в export.js, лимит размера файла в nginx (`client_max_body_size 50m`) |
| Keycloak ↔ AD: конфигурация LDAP сложная | Средняя | подготовить `realm-export.json` с тестовым LDAP, итерировать с AD-админом |
| Ollama требует GPU | Низкая | в `docker-compose.yml` GPU опционален; fallback на OpenAI API через env |
| Одновременные job'ы перегружают Ollama | Средняя | лимит concurrency в BullMQ (`{ concurrency: 2 }` на OCR-воркере) |

---

## 11. Что остаётся на потом (backlog)

- SSE / email-уведомление при завершении длинного job'а
- Батчевая загрузка ZIP (перенос `BatchWindow` логики в API)
- Glossary-управление через UI (сейчас только JSON-файл)
- Метрики (Prometheus + Grafana) — подключить к nginx и api
- Резервное копирование PostgreSQL + MinIO (cron + rclone)
- Rate limiting per user в nginx/Fastify
