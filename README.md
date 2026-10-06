# expense-api

Backend of the **Expense Tracker**: a JSON REST API (Node.js + Express + PostgreSQL).
Deployed on **Epinio from plain source code**: no Dockerfile, no CI.
The frontend is a separate app: [expense-web](https://github.com/iindiG0/expense-web).

```
Browser ──► expense-web (React, static files on nginx)
   │
   └─(fetch, CORS)──► expense-api (this repo) ──► PostgreSQL (CloudNativePG)
```

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/expenses?month=2026-10` | List expenses of a month |
| GET | `/api/summary?month=2026-10` | Total + total per category |
| GET | `/api/categories` | Allowed categories |
| POST | `/api/expenses` | Create `{spent_on, category, description, amount}` |
| PUT | `/api/expenses/:id` | Update |
| DELETE | `/api/expenses/:id` | Delete |
| GET | `/healthz` | Health check |

The app creates its `expenses` table by itself on first start.

## Environment variables

| Name | Example | What it does |
|---|---|---|
| `DATABASE_URL` | `postgresql://app:...@expense-db-rw.client-a:5432/app` | **Required.** From the CNPG Secret `expense-db-app` (key `uri`) |
| `ALLOWED_ORIGIN` | `https://expense-web.10.27.60.80.sslip.io` | Frontend URL allowed to call the API (CORS). Default `*` |

## Database

`cnpg-db.yaml` creates a CloudNativePG cluster `expense-db` in namespace `client-a` (applied by the admin with kubectl).

## Run locally

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost/app ALLOWED_ORIGIN=http://localhost:5173 npm start
```
