const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

const db = require("./db");
const { requireAuth } = require("./auth");

const app = express();
const PORT = process.env.PORT || 3000;

// Session secret persists across restarts in data/session-secret so logins
// aren't wiped every time the shop PC reboots the app.
const SECRET_PATH = path.join(__dirname, "..", "data", "session-secret.txt");
let sessionSecret;
if (fs.existsSync(SECRET_PATH)) {
  sessionSecret = fs.readFileSync(SECRET_PATH, "utf8").trim();
} else {
  sessionSecret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_PATH, sessionSecret);
}

const isProduction = process.env.NODE_ENV === "production";

// Behind Fly.io's proxy, TLS is terminated upstream and requests reach us
// over plain HTTP with X-Forwarded-Proto set — trust it so secure cookies work.
app.set("trust proxy", 1);

app.use(express.json());
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days — shop staff shouldn't have to re-enter the PIN daily
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction
  }
}));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/settings", requireAuth, require("./routes/settings"));
app.use("/api/products", requireAuth, require("./routes/products"));
app.use("/api/customers", requireAuth, require("./routes/customers"));
app.use("/api/invoices", requireAuth, require("./routes/invoices"));
app.use("/api/reports", requireAuth, require("./routes/reports"));

app.use(express.static(path.join(__dirname, "..", "public")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Shop Manager running on port ${PORT}`);
  if (!isProduction) {
    console.log(`Open http://localhost:${PORT}`);
    console.log("On other phones/tablets on the same WiFi, use this PC's local IP address instead of localhost.");
  }
});
