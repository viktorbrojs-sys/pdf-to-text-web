.PHONY: up down build logs migrate seed-admin ps clean

# ── Production ─────────────────────────────────────────────────────────────────
up:
	docker compose up -d --build

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f --tail=100

ps:
	docker compose ps

# ── Dev ────────────────────────────────────────────────────────────────────────
dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

dev-down:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml down

# ── Database ───────────────────────────────────────────────────────────────────
migrate:
	docker compose exec api npx prisma migrate deploy

migrate-dev:
	docker compose exec api npx prisma migrate dev

studio:
	docker compose exec api npx prisma studio

# ── Seed first admin user ──────────────────────────────────────────────────────
# Использование: make seed-admin EMAIL=admin@company.local KC_ID=<keycloak-user-id>
seed-admin:
	docker compose exec postgres psql -U postgres -d pdftotextdb -c \
		"INSERT INTO \"User\" (id, \"keycloakId\", username, email, role, \"createdAt\", \"updatedAt\") \
		 VALUES (gen_random_uuid(), '$(KC_ID)', '$(EMAIL)', '$(EMAIL)', 'ADMIN', now(), now()) \
		 ON CONFLICT (\"keycloakId\") DO UPDATE SET role = 'ADMIN';"

# ── MinIO setup ────────────────────────────────────────────────────────────────
minio-setup:
	docker compose exec minio mc alias set local http://localhost:9000 \
		$$(grep MINIO_ACCESS_KEY .env | cut -d= -f2) \
		$$(grep MINIO_SECRET_KEY .env | cut -d= -f2)
	docker compose exec minio mc mb --ignore-existing local/documents local/exports

# ── Ollama model pull ──────────────────────────────────────────────────────────
pull-llava:
	docker compose exec ollama ollama pull llava:latest

pull-mistral:
	docker compose exec ollama ollama pull mistral:latest

# ── Cleanup ────────────────────────────────────────────────────────────────────
clean:
	docker compose down -v --remove-orphans
	rm -rf data/uploads/* data/output/*
