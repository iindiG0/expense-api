// expense-api: JSON REST API for the Expense Tracker.
// The frontend (expense-web) is a separate Epinio app on a different URL,
// so this API must send CORS headers that allow the frontend's origin.
//
// Environment variables:
//   DATABASE_URL    PostgreSQL connection string (required)
//   ALLOWED_ORIGIN  Frontend URL allowed to call this API, e.g.
//                   https://expense-web.10.27.60.80.sslip.io  ("*" = allow all)
//   PORT            Set by Epinio (default 8080)

const express = require("express");
const os = require("os");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const CATEGORIES = ["Food", "Transport", "Bills", "Shopping", "Health", "Entertainment", "Other"];

if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Set it in Epinio: Applications > expense-api > Environment.");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// CORS: the browser loads the page from expense-web and calls expense-api.
// Different hostnames = different "origins", so the browser asks this API
// for permission first (preflight OPTIONS request) before POST/PUT/DELETE.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Vary", "Origin");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Database setup (retries while the database is starting)
// ---------------------------------------------------------------------------
async function ensureTable() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
          id          SERIAL PRIMARY KEY,
          spent_on    DATE NOT NULL,
          category    TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          amount      NUMERIC(10,2) NOT NULL CHECK (amount > 0),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      await pool.query("CREATE INDEX IF NOT EXISTS expenses_spent_on_idx ON expenses (spent_on)");
      console.log("Connected to PostgreSQL, table 'expenses' is ready");
      return;
    } catch (err) {
      console.error(`Database not ready (attempt ${attempt}): ${err.message}`);
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// "2026-10" -> first and last day of that month. Default: current month.
function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || "");
  const now = new Date();
  const year = m ? Number(m[1]) : now.getUTCFullYear();
  const mon = m ? Number(m[2]) : now.getUTCMonth() + 1;
  const start = `${year}-${String(mon).padStart(2, "0")}-01`;
  const next = mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, "0")}-01`;
  return { start, next };
}

// Validate the request body for create/update. Returns [error, cleanData].
function validate(body) {
  const spent_on = String(body.spent_on || "");
  const category = String(body.category || "");
  const description = String(body.description || "").trim().slice(0, 200);
  const amount = Number(body.amount);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spent_on)) return ["Date must be YYYY-MM-DD"];
  if (!CATEGORIES.includes(category)) return [`Category must be one of: ${CATEGORIES.join(", ")}`];
  if (!Number.isFinite(amount) || amount <= 0 || amount > 99999999) return ["Amount must be a positive number"];
  return [null, { spent_on, category, description, amount: Math.round(amount * 100) / 100 }];
}

// PostgreSQL returns NUMERIC as a string and DATE as a Date; make them JSON-friendly.
function toJson(row) {
  return {
    id: row.id,
    spent_on: row.spent_on,
    category: row.category,
    description: row.description,
    amount: Number(row.amount),
  };
}

const handle = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    res.status(500).json({ error: "Server error: " + err.message });
  });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/", (req, res) =>
  res.json({ app: "expense-api", pod: os.hostname(), endpoints: ["/api/expenses", "/api/summary", "/api/categories", "/healthz"] })
);

app.get("/healthz", (req, res) => res.send("ok"));

app.get("/api/categories", (req, res) => res.json(CATEGORIES));

// List expenses for a month: GET /api/expenses?month=2026-10
app.get("/api/expenses", handle(async (req, res) => {
  const { start, next } = monthRange(req.query.month);
  const { rows } = await pool.query(
    `SELECT id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, description, amount
       FROM expenses WHERE spent_on >= $1 AND spent_on < $2
      ORDER BY spent_on DESC, id DESC`,
    [start, next]
  );
  res.json(rows.map(toJson));
}));

// Totals for a month: GET /api/summary?month=2026-10
app.get("/api/summary", handle(async (req, res) => {
  const { start, next } = monthRange(req.query.month);
  const { rows } = await pool.query(
    `SELECT category, SUM(amount) AS total, COUNT(*) AS count
       FROM expenses WHERE spent_on >= $1 AND spent_on < $2
      GROUP BY category ORDER BY SUM(amount) DESC`,
    [start, next]
  );
  const byCategory = rows.map((r) => ({ category: r.category, total: Number(r.total), count: Number(r.count) }));
  const total = byCategory.reduce((sum, r) => sum + r.total, 0);
  res.json({ month: start.slice(0, 7), total: Math.round(total * 100) / 100, byCategory, pod: os.hostname() });
}));

// Create: POST /api/expenses  {spent_on, category, description, amount}
app.post("/api/expenses", handle(async (req, res) => {
  const [error, e] = validate(req.body || {});
  if (error) return res.status(400).json({ error });
  const { rows } = await pool.query(
    `INSERT INTO expenses (spent_on, category, description, amount) VALUES ($1, $2, $3, $4)
     RETURNING id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, description, amount`,
    [e.spent_on, e.category, e.description, e.amount]
  );
  res.status(201).json(toJson(rows[0]));
}));

// Update: PUT /api/expenses/:id
app.put("/api/expenses/:id", handle(async (req, res) => {
  const [error, e] = validate(req.body || {});
  if (error) return res.status(400).json({ error });
  const { rows } = await pool.query(
    `UPDATE expenses SET spent_on = $2, category = $3, description = $4, amount = $5 WHERE id = $1
     RETURNING id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, description, amount`,
    [Number(req.params.id), e.spent_on, e.category, e.description, e.amount]
  );
  if (!rows.length) return res.status(404).json({ error: "Expense not found" });
  res.json(toJson(rows[0]));
}));

// Delete: DELETE /api/expenses/:id
app.delete("/api/expenses/:id", handle(async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM expenses WHERE id = $1", [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: "Expense not found" });
  res.sendStatus(204);
}));

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Start listening right away (so Epinio sees the app as up), and prepare the table.
app.listen(PORT, () => console.log(`expense-api listening on port ${PORT} (CORS origin: ${ALLOWED_ORIGIN})`));
ensureTable().catch((err) => {
  console.error("Could not prepare the database, exiting:", err.message);
  process.exit(1);
});
