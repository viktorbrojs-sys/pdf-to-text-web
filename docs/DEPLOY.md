# Развёртывание PDF to Text Web

## Требования

- Docker Engine ≥ 24, Docker Compose ≥ 2.24
- ОС: Linux (Ubuntu 22.04 / Debian 12 рекомендуется)
- RAM ≥ 8 ГБ (≥ 16 ГБ с Ollama)
- Диск ≥ 40 ГБ (+ место под модели Ollama ~4–8 ГБ каждая)
- Порты: 80, 443 открыты в LAN

## Быстрый старт

```bash
# 1. Клонируем репозиторий
git clone https://github.com/viktorbrojs-sys/pdf-to-text-web.git
cd pdf-to-text-web

# 2. Создаём .env
cp .env.example .env
# Заполняем .env (обязательно: POSTGRES_PASSWORD, MINIO_SECRET_KEY, COOKIE_SECRET, APP_URL)

# 3. Создаём папки для данных
mkdir -p data/uploads data/output infra/nginx/certs

# 4. (HTTPS) Кладём сертификаты:
# infra/nginx/certs/fullchain.pem
# infra/nginx/certs/privkey.pem
# Для тестирования — самоподписанный:
openssl req -x509 -newkey rsa:4096 -keyout infra/nginx/certs/privkey.pem \
  -out infra/nginx/certs/fullchain.pem -days 365 -nodes \
  -subj "/CN=pdf.company.local"

# 5. Запускаем
make up

# 6. Применяем миграции БД (после того как все контейнеры поднялись)
make migrate

# 7. Скачиваем модель Ollama (необязательно, только для AI Vision)
make pull-llava
```

## Настройка Keycloak

1. Открыть `http://<server>:8080` (Keycloak Admin Console)
2. Войти: admin / `KEYCLOAK_ADMIN_PASSWORD` из .env
3. Realm `pdf-to-text` уже импортирован из `infra/keycloak/realm-export.json`
4. **Клиент** → `pdf-to-text-api` → **Credentials** → скопировать `Secret` → вставить в `.env` как `KEYCLOAK_CLIENT_SECRET`
5. Перезапустить api: `docker compose restart api`

## Интеграция с Active Directory

1. Keycloak Admin → **User Federation** → Add provider → **LDAP**
2. Заполнить поля из `realm-export.json` (секция `userFederationProviders`):
   - `Connection URL`: `ldap://your-ad-server:389`
   - `Bind DN`: сервисный аккаунт AD
   - `Users DN`: `OU=Users,DC=company,DC=local`
3. **Synchronize all users** → пользователи появятся в Keycloak
4. **Роли**: в Keycloak назначить роли `USER/MANAGER/ADMIN` нужным пользователям или группам AD

## Назначение первого администратора

```bash
# Найти keycloakId пользователя в Keycloak Admin → Users → выбрать → скопировать ID
make seed-admin EMAIL=admin@company.local KC_ID=<keycloak-user-uuid>
```

## Масштабирование воркеров

```bash
docker compose up -d --scale worker=4
```

## Обновление

```bash
git pull
make build
make up
make migrate
```

## Полный сброс (удаляет все данные!)

```bash
make clean
```

## Логи

```bash
make logs                         # все сервисы
docker compose logs -f api        # только api
docker compose logs -f worker     # воркеры OCR/перевода
```
