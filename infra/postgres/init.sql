-- Расширения
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- для полнотекстового поиска по именам файлов

-- Индексы на часто фильтруемые поля (Prisma создаёт основные, добавляем дополнительные)
-- Эти запустятся после того как Prisma migrate создаст таблицы,
-- поэтому оборачиваем в DO-блок с проверкой

DO $$
BEGIN
  -- Индекс для быстрой фильтрации аудит-лога по дате (DESC)
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE tablename = 'AuditLog' AND indexname = 'idx_auditlog_created_desc'
  ) THEN
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_auditlog_created_desc
      ON "AuditLog" ("createdAt" DESC);
  END IF;
END
$$;
