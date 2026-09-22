# Monroe — серверные модули

Выделенная часть проекта: авторизация по email и Telegram, PostgreSQL, пополнение баланса через Platega и Transa.

Это набор модулей для Next.js App Router, а не полный сайт. Страницы входа, регистрации, личного кабинета и возврата из платёжной формы здесь отсутствуют; их предоставляет приложение, в которое встраиваются модули.

## Проверка типов

```bash
pnpm install --frozen-lockfile
pnpm typecheck
```

## Подключение

Сохраните пути `app/api`, `lib` и `db` в приложении Next.js и настройте alias `@/*` на его корень. Пример серверных переменных находится в `.env.example`; реальные значения храните в окружении или локальном env-файле.

`lib/db.ts` управляет пулом PostgreSQL. `db/schema.ts` создаёт и обновляет таблицы пользователей, сессий, входа через Telegram и платежей при первом обращении.

Обработчики ожидают страницы `/login`, `/register`, `/account` и `/account/top-up`. Callback URL для Telegram: `/api/auth/telegram/callback`. Платёжные webhooks: `/api/payments/platega/webhook` и `/api/payments/transa/webhook`.
