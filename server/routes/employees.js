/* ============================================================
   STAFF PAY — the API

   Thin on purpose. Every figure comes from ../payroll, so this file
   validates, writes a row, and records who did it. It never adds money
   up itself: two places doing that is how a dashboard and a ledger come
   to disagree about the same employee.

   ROUTE ORDER MATTERS HERE. Express matches in the order routes are
   declared, so every fixed path — /dashboard, /settings, /attendance —
   is declared BEFORE /:id. The other way round, "dashboard" arrives as
   an employee id and the screen 404s for reasons nobody can see. The
   invoices router learnt this the hard way with /search.

   PERMISSIONS follow the module's own split:
     view  reading anything
     add   the daily work — marking attendance, handing out kharchi
     edit  the money decisions — salaries, deductions, payments, voids
   ============================================================ */
const express = require("express");
const db = require("../db");
const payroll = require("../payroll");
const { uid, logAction, round2, todayStr } = require("../util");
const perms = require("../permissions");

const router = express.Router();

/* ---------------------------------------------------------- helpers */

const STATUSES = ["present", "absent", "half", "leave"];
const METHODS  = ["Cash", "UPI", "Other"];

/**
 * SALARY IS THE OWNER'S BUSINESS.
 *
 * Staff Pay view lets a manager run the register and hand out kharchi.
 * It does not let them read what anybody earns, what is still owed to
 * them, or what they cost the shop. Those are stripped from the
 * response rather than hidden on the screen: a figure that reaches the
 * browser has already left the building, and hiding it in CSS is not a
 * restriction, it is a decoration.
 */
function seesSalary(req) { return perms.canSee(req, "salary"); }

const SALARY_FIELDS = ["salary", "gross", "netPayable", "paid", "remaining",
                       "totalCost", "deductions", "expenses", "status"];

/** Blanks the money on one row, leaving name, role, attendance, kharchi. */
function scrubRow(req, row) {
  if (seesSalary(req) || !row) return row;
  const out = { ...row };
  for (const k of SALARY_FIELDS) if (k in out) out[k] = null;
  out.salaryHidden = true;
  return out;
}

function who(req) {
  return (req.session && req.session.staffName) || "";
}

/** A money amount that is actually a number and actually positive. */
function amountOf(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return null;
  return round2(n);
}

function dateOf(v) {
  const s = String(v || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function monthArg(v) {
  const s = String(v || "").trim();
  return /^\d{4}-\d{2}$/.test(s) ? s : payroll.monthOf(todayStr());
}

function employeeOr404(id, res) {
  const e = db.prepare("SELECT * FROM employees WHERE id = ?").get(id);
  if (!e) { res.status(404).json({ error: "That employee does not exist." }); return null; }
  return e;
}

/**
 * One place that writes a money row, because all six of them are the same
 * shape and a copy each is six chances to forget the audit line.
 */
function addRow(cfg) {
  return (req, res) => {
    const b = req.body || {};
    const emp = employeeOr404(b.employeeId, res);
    if (!emp) return;

    const amount = amountOf(b.amount);
    if (amount === null) return res.status(400).json({ error: "Enter an amount greater than zero." });

    const date = dateOf(b.date) || todayStr();
    const method = METHODS.includes(b.method) ? b.method : "Cash";
    const id = uid(cfg.prefix);
    const month = payroll.monthOf(date);

    cfg.insert({ id, emp, amount, date, method, month, b, req });
    logAction(req, cfg.action, `${emp.name}: ₹${amount} on ${date}${b.reason ? " — " + b.reason : ""}`);
    res.json({ id, ok: true, month: payroll.employeeMonth(emp.id, month) });
  };
}

/** Voiding, also identical six times over. Never deletes. */
function voidRow(table, action, label) {
  return (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: "That record does not exist." });
    if (row.voided) return res.status(400).json({ error: "That record is already cancelled." });

    db.prepare(`UPDATE ${table} SET voided = 1 WHERE id = ?`).run(req.params.id);
    const emp = db.prepare("SELECT name FROM employees WHERE id = ?").get(row.employee_id) || {};
    logAction(req, action, `${emp.name || row.employee_id}: cancelled ${label} of ₹${row.amount} dated ${row.date}`);
    res.json({ ok: true });
  };
}

/* ================================================================
   FIXED PATHS FIRST — see the note at the top of this file
   ================================================================ */

/* ------------------------------------------------------ payroll rules */

router.get("/settings", perms.require("employee", "view"), (req, res) => {
  res.json(payroll.settings());
});

router.put("/settings", perms.require("employee", "edit"), (req, res) => {
  const b = req.body || {};
  const before = payroll.settings();
  const on = b.deductByAttendance ? 1 : 0;
  const basis = ["month_days", "fixed_26", "fixed_30"].includes(b.dayBasis) ? b.dayBasis : "month_days";
  const half = Number(b.halfDayFactor);
  const leavePaid = b.leaveIsPaid ? 1 : 0;

  db.prepare(`UPDATE employee_settings
                 SET deduct_by_attendance = ?, day_basis = ?, half_day_factor = ?, leave_is_paid = ?
               WHERE id = 1`)
    .run(on, basis, (isFinite(half) && half >= 0 && half <= 1) ? half : 0.5, leavePaid);

  /* Worth an audit line of its own: this one switch silently changes what
     every employee is owed, so a shop must be able to see when it moved
     and who moved it. */
  if (before.deduct_by_attendance !== on) {
    logAction(req, "employee.settings.deduction",
      `attendance deduction turned ${on ? "ON" : "OFF"}`);
  } else {
    logAction(req, "employee.settings", `basis ${basis}, half day ${half}, leave ${leavePaid ? "paid" : "unpaid"}`);
  }
  res.json(payroll.settings());
});

/* ------------------------------------------------------- dashboards */

router.get("/dashboard", perms.require("employee", "view"), (req, res) => {
  const month = monthArg(req.query.month);
  const today = todayStr();
  const day = payroll.dayAttendance(today);

  /* This week, Monday to Sunday, from today. */
  const d = new Date(today + "T00:00:00");
  const dow = (d.getDay() + 6) % 7;                 /* Monday = 0 */
  const mon = new Date(d); mon.setDate(d.getDate() - dow);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const iso = (x) => x.toISOString().slice(0, 10);

  const week = payroll.kharchiBoard(iso(mon), iso(sun));
  const totals = payroll.monthTotals(month);

  res.json({
    month, today,
    todayAttendance: { present: day.present, absent: day.absent, half: day.half,
                       leave: day.leave, unmarked: day.unmarked, total: day.total },
    weekKharchi: { from: iso(mon), to: iso(sun), total: week.total, transactions: week.transactions },
    monthKharchi: totals.totals.kharchi,
    totals: seesSalary(req) ? totals.totals
            : { kharchi: totals.totals.kharchi, advances: totals.totals.advances,
                salary: null, netPayable: null, paid: null, outstanding: null,
                totalCost: null, expenses: null, deductions: null },
    salaryHidden: !seesSalary(req),
    employees: totals.employees,
    rows: totals.rows.map(r => scrubRow(req, {
      id: r.employee.id, name: r.employee.name, role: r.employee.job_role,
      salary: r.gross, kharchi: r.kharchi, advances: r.advances,
      deductions: round2(r.deductions + r.attendanceDeduction.amount),
      paid: r.paid, remaining: r.remaining, totalCost: r.totalCost, status: r.status
    }))
  });
});

router.get("/kharchi-board", perms.require("employee", "view"), (req, res) => {
  const from = dateOf(req.query.from), to = dateOf(req.query.to);
  if (!from || !to) return res.status(400).json({ error: "Give a from and to date." });
  res.json(payroll.kharchiBoard(from, to));
});

/* ------------------------------------------------------- attendance */

router.get("/attendance", perms.require("employee", "view"), (req, res) => {
  const date = dateOf(req.query.date) || todayStr();
  res.json(payroll.dayAttendance(date));
});

/**
 * Mark or correct one day for one employee.
 *
 * Marking is `add` — it is the daily job. CHANGING a day already marked
 * is `edit`, because an attendance record that anyone can rewrite is not
 * a record. The route decides which of the two this is by looking first.
 */
router.post("/attendance", perms.require("employee", "add"), (req, res) => {
  const b = req.body || {};
  const emp = employeeOr404(b.employeeId, res);
  if (!emp) return;

  const date = dateOf(b.date) || todayStr();
  const status = String(b.status || "").toLowerCase();
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: "Status must be present, absent, half or leave." });
  }

  const existing = db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND date = ?")
                     .get(emp.id, date);

  if (existing && existing.status !== status && !perms.can(req, "employee", "edit")) {
    return res.status(403).json({
      error: "Changing attendance that is already marked needs Staff Pay edit permission."
    });
  }

  if (existing) {
    db.prepare("UPDATE attendance SET status=?, note=?, marked_by=?, at=? WHERE id=?")
      .run(status, String(b.note || ""), who(req), Date.now(), existing.id);
    if (existing.status !== status) {
      logAction(req, "employee.attendance.change",
        `${emp.name} ${date}: ${existing.status} -> ${status}`);
    }
  } else {
    db.prepare(`INSERT INTO attendance (id,employee_id,date,status,note,marked_by,at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(uid("ATT"), emp.id, date, status, String(b.note || ""), who(req), Date.now());
    logAction(req, "employee.attendance", `${emp.name} ${date}: ${status}`);
  }
  res.json(payroll.dayAttendance(date));
});

/* ------------------------------------------------------------ money */

router.post("/kharchi", perms.require("employee", "add"), addRow({
  prefix: "KH", action: "employee.kharchi",
  insert: ({ id, emp, amount, date, method, b, req }) =>
    db.prepare(`INSERT INTO kharchi_transactions
                (id,employee_id,amount,date,reason,method,recorded_by,at,voided)
                VALUES (?,?,?,?,?,?,?,?,0)`)
      .run(id, emp.id, amount, date, String(b.reason || ""), method, who(req), Date.now())
}));
router.post("/kharchi/:id/void", perms.require("employee", "edit"),
  voidRow("kharchi_transactions", "employee.kharchi.void", "kharchi"));

router.post("/advance", perms.require("employee", "add"), addRow({
  prefix: "ADV", action: "employee.advance",
  insert: ({ id, emp, amount, date, method, b, req }) =>
    db.prepare(`INSERT INTO salary_advances
                (id,employee_id,amount,date,reason,method,recorded_by,at,voided)
                VALUES (?,?,?,?,?,?,?,?,0)`)
      .run(id, emp.id, amount, date, String(b.reason || ""), method, who(req), Date.now())
}));
router.post("/advance/:id/void", perms.require("employee", "edit"),
  voidRow("salary_advances", "employee.advance.void", "advance"));

router.post("/deduction", perms.require("employee", "edit"), addRow({
  prefix: "DED", action: "employee.deduction",
  insert: ({ id, emp, amount, date, month, b, req }) =>
    db.prepare(`INSERT INTO salary_deductions
                (id,employee_id,month,amount,date,reason,recorded_by,at,voided)
                VALUES (?,?,?,?,?,?,?,?,0)`)
      .run(id, emp.id, monthArg(b.month) || month, amount, date,
           String(b.reason || ""), who(req), Date.now())
}));
router.post("/deduction/:id/void", perms.require("employee", "edit"),
  voidRow("salary_deductions", "employee.deduction.void", "deduction"));

router.post("/expense", perms.require("employee", "add"), addRow({
  prefix: "EEX", action: "employee.expense",
  insert: ({ id, emp, amount, date, month, b, req }) =>
    db.prepare(`INSERT INTO employee_expenses
                (id,employee_id,month,amount,date,category,note,recorded_by,at,voided)
                VALUES (?,?,?,?,?,?,?,?,?,0)`)
      .run(id, emp.id, monthArg(b.month) || month, amount, date,
           String(b.category || ""), String(b.note || ""), who(req), Date.now())
}));
router.post("/expense/:id/void", perms.require("employee", "edit"),
  voidRow("employee_expenses", "employee.expense.void", "expense"));

/**
 * Pay a salary.
 *
 * `edit`, not `add` — handing over a month of wages is a different kind of
 * act from writing down that somebody took ₹500 on Tuesday.
 *
 * Overpayment is REFUSED rather than silently allowed: a payment larger
 * than what is owed is almost always a typed extra zero, and the shop
 * would find out at the end of the month.
 */
router.post("/salary-payment", perms.require("employee", "edit"), (req, res) => {
  const b = req.body || {};
  const emp = employeeOr404(b.employeeId, res);
  if (!emp) return;

  const amount = amountOf(b.amount);
  if (amount === null) return res.status(400).json({ error: "Enter an amount greater than zero." });

  const date = dateOf(b.date) || todayStr();
  const month = monthArg(b.month);
  const method = METHODS.includes(b.method) ? b.method : "Cash";

  const before = payroll.employeeMonth(emp.id, month);
  if (amount > before.remaining + 0.5 && !b.allowOverpay) {
    return res.status(400).json({
      error: `Only ₹${before.remaining.toFixed(2)} is still owed for ${month}. `
           + `Send allowOverpay to pay more than that on purpose.`,
      remaining: before.remaining
    });
  }

  const id = uid("SPAY");
  db.prepare(`INSERT INTO salary_payments
              (id,employee_id,month,amount,date,method,notes,recorded_by,at,voided)
              VALUES (?,?,?,?,?,?,?,?,?,0)`)
    .run(id, emp.id, month, amount, date, method, String(b.notes || ""), who(req), Date.now());

  logAction(req, "employee.salary.pay", `${emp.name}: ₹${amount} for ${month} by ${method}`);
  res.json({ id, ok: true, month: payroll.employeeMonth(emp.id, month) });
});
router.post("/salary-payment/:id/void", perms.require("employee", "edit"),
  voidRow("salary_payments", "employee.salary.void", "salary payment"));

/* ------------------------------------------------------ the list */

router.get("/", perms.require("employee", "view"), (req, res) => {
  const month = monthArg(req.query.month);
  const includeInactive = String(req.query.all || "") === "1";
  const t = payroll.monthTotals(month, { includeInactive });
  res.json({
    month,
    salaryHidden: !seesSalary(req),
    employees: t.rows.map(r => scrubRow(req, {
      id: r.employee.id, name: r.employee.name, mobile: r.employee.mobile,
      role: r.employee.job_role, active: r.employee.active,
      salary: r.gross, kharchi: r.kharchi, advances: r.advances,
      deductions: round2(r.deductions + r.attendanceDeduction.amount),
      paid: r.paid, remaining: r.remaining, totalCost: r.totalCost, status: r.status
    })),
    totals: seesSalary(req) ? t.totals : { kharchi: t.totals.kharchi, advances: t.totals.advances }
  });
});

router.post("/", perms.require("employee", "edit"), (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return res.status(400).json({ error: "An employee needs a name." });

  const salary = Number(b.monthlySalary);
  if (!isFinite(salary) || salary < 0) {
    return res.status(400).json({ error: "Monthly salary must be zero or more." });
  }

  const id = uid("EMP");
  db.prepare(`INSERT INTO employees
              (id,name,mobile,job_role,joining_date,monthly_salary,salary_type,active,notes,created_at,created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, String(b.mobile || ""), String(b.jobRole || ""),
         dateOf(b.joiningDate) || "", round2(salary),
         ["monthly", "daily", "weekly"].includes(b.salaryType) ? b.salaryType : "monthly",
         b.active === false ? 0 : 1, String(b.notes || ""), Date.now(), who(req));

  logAction(req, "employee.create", `${name} at ₹${round2(salary)}/month`);
  res.json({ id, ok: true });
});

/* ------------------------------------------------- one employee */

router.get("/:id", perms.require("employee", "view"), (req, res) => {
  const month = monthArg(req.query.month);
  const m = payroll.employeeMonth(req.params.id, month);
  if (!m) return res.status(404).json({ error: "That employee does not exist." });
  const emp = db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
  if (!seesSalary(req)) {
    /* Attendance and kharchi survive; everything that is or implies a
       salary does not — including the workings, which would otherwise
       spell out the figure they were meant to hide. */
    const safe = scrubRow(req, m);
    safe.workings = null;
    safe.attendanceDeduction = { applied: m.attendanceDeduction.applied, amount: null,
                                 absentDays: m.attendanceDeduction.absentDays,
                                 halfDays: m.attendanceDeduction.halfDays,
                                 leaveDays: m.attendanceDeduction.leaveDays };
    const { monthly_salary, ...profileSafe } = emp || {};
    return res.json({ ...safe, profile: profileSafe });
  }
  res.json({ ...m, profile: emp });
});

router.get("/:id/ledger", perms.require("employee", "view"), (req, res) => {
  const emp = employeeOr404(req.params.id, res);
  if (!emp) return;
  const month = monthArg(req.query.month);
  const r = payroll.monthRange(month);
  const from = dateOf(req.query.from) || r.from;
  const to   = dateOf(req.query.to)   || r.to;
  res.json({ employee: { id: emp.id, name: emp.name, salary: emp.monthly_salary },
             from, to,
             attendance: payroll.attendanceSummary(emp.id, month),
             salaryHidden: !seesSalary(req),
             lines: payroll.ledger(emp.id, from, to)
                      .filter(l => seesSalary(req) || (l.kind !== "Salary Paid" && l.kind !== "Deduction")) });
});

router.get("/:id/attendance", perms.require("employee", "view"), (req, res) => {
  const emp = employeeOr404(req.params.id, res);
  if (!emp) return;
  const month = monthArg(req.query.month);
  const r = payroll.monthRange(month);
  res.json({
    month,
    summary: payroll.attendanceSummary(emp.id, month),
    days: db.prepare(`SELECT date, status, note, marked_by FROM attendance
                       WHERE employee_id=? AND date>=? AND date<=? ORDER BY date`)
            .all(emp.id, r.from, r.to)
  });
});

/**
 * Change an employee.
 *
 * `edit`, and the salary change is logged with both figures. What somebody
 * is paid is the single most disputed number in a shop, and "it was always
 * that" is not something a ledger should have to take on trust.
 */
router.put("/:id", perms.require("employee", "edit"), (req, res) => {
  const emp = employeeOr404(req.params.id, res);
  if (!emp) return;
  const b = req.body || {};

  const name = String(b.name != null ? b.name : emp.name).trim();
  if (!name) return res.status(400).json({ error: "An employee needs a name." });

  let salary = emp.monthly_salary;
  if (b.monthlySalary != null) {
    const n = Number(b.monthlySalary);
    if (!isFinite(n) || n < 0) return res.status(400).json({ error: "Monthly salary must be zero or more." });
    salary = round2(n);
  }

  db.prepare(`UPDATE employees SET name=?, mobile=?, job_role=?, joining_date=?,
                     monthly_salary=?, salary_type=?, active=?, notes=? WHERE id=?`)
    .run(name, String(b.mobile != null ? b.mobile : emp.mobile),
         String(b.jobRole != null ? b.jobRole : emp.job_role),
         dateOf(b.joiningDate) || emp.joining_date,
         salary,
         ["monthly","daily","weekly"].includes(b.salaryType) ? b.salaryType : emp.salary_type,
         b.active == null ? emp.active : (b.active ? 1 : 0),
         String(b.notes != null ? b.notes : emp.notes),
         emp.id);

  if (Number(emp.monthly_salary) !== Number(salary)) {
    logAction(req, "employee.salary.change",
      `${name}: ₹${emp.monthly_salary} -> ₹${salary}`);
  } else {
    logAction(req, "employee.edit", name);
  }
  res.json({ ok: true });
});

module.exports = router;
