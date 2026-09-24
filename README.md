# pdf-to-text — Web Platform

Web-версия десктопного приложения [pdf-to-text](https://github.com/viktorbrojs-sys/pdf-to-text) для развёртывания в локальной сети организации.

## Возможности

- 📄 OCR PDF-файлов (AI Vision, Tesseract, TextPDF, UnlimOCR)
- 🌍 Перевод текста (Ollama, OpenAI, DeepL, DeepSeek)
- 💾 Экспорт в MD / DOCX / PDF
- 👥 Многопользовательский режим с авторизацией через AD (Keycloak)
- 🔐 Разграничение прав: USER / MANAGER / ADMIN
- 📋 Аудит-лог всех действий
- 🖥️ Админ-панель

## Стек

| Слой | Технология |
|---|---|
| Frontend | React + Vite |
| Backend | Fastify + TypeScript |
| Auth | Keycloak (OIDC + LDAP/AD) |
| БД | PostgreSQL + Prisma |
| Очередь | BullMQ + Redis |
| Хранилище | MinIO (S3) |
| LLM / OCR | Ollama (self-hosted) |
| Прокси | nginx |
| Деплой | Docker Compose |

## Быстрый старт

```bash
cp .env.example .env
# заполните .env
make up
```

Подробнее: [docs/DEPLOY.md](docs/DEPLOY.md) · [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md)

## Структура

```
apps/
  api/      — Fastify backend (Node.js + TypeScript)
  web/      — React SPA
infra/
  nginx/
  keycloak/
  postgres/
docs/
```

## Этапы разработки

- [x] Документация и план
- [ ] Этап 1 — Backend-скелет (Fastify + Auth + DB)
- [ ] Этап 2 — Бизнес-логика (OCR + перевод + экспорт через API)
- [ ] Этап 3 — Фронтенд-адаптация
- [ ] Этап 4 — Админ-панель
- [ ] Этап 5 — Docker Compose + деплой
- [ ] Этап 6 — Интеграция с AD
