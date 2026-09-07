/* ============================================================
   PAYROLL — every figure the staff-pay module shows

   The arithmetic lives here and NOT in the routes, for the same reason
   the Tally processor is separate from its router: there is exactly one
   place that decides what an employee costs, so the dashboard, the
   profile, the ledger and the reports cannot quietly disagree with each
   other. A route in this module never adds up money itself.

   THE RULE THAT THE WHOLE MODULE TURNS ON
   ---------------------------------------
   Kharchi and advances are salary paid EARLY. They are not extra cost.

     Salary 20,000, kharchi 2,000
       -> the shop spent 20,000 on this employee
       -> 18,000 is still owed to them
       -> NOT 22,000, which would book the same rupee twice

   So two different questions are answered by two different sums:

     what is still OWED   = gross - deductions - kharchi - advances - paid
     what it COSTS        = gross + employee_expenses

   employee_expenses is the only table that adds to cost, because it is
   the only money that is not part of the salary figure already.

   UNMARKED DAYS ARE NOT ABSENCES. A day with no attendance row deducts
   nothing. A shop that forgets to mark a Sunday must not find a day's pay
   missing — only an explicit "absent" costs anybody money.
   ============================================================ */
const db = require("./db");
const { round2 } = require("./util");

/* ---------------------------------------------------------------- dates */

/** "2026-09-14" -> "2026-09". Also accepts a month and returns it. */
function monthOf(dateStr) {
  return String(dateStr || "").slice(0, 7);
}

function daysInMonth(month) {
  const [y, m] = String(month).split("-").map(Number);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}

/** First and last calendar day of a YYYY-MM, as YYYY-MM-DD. */
function monthRange(month) {
  const d = daysInMonth(month);
  return { from: month + "-01", to: month + "-" + String(d).padStart(2, "0") };
}

/* ---------------------------------------------------------------- rules */

function settings() {
  const r = db.prepare("SELECT * FROM employee_settings WHERE id = 1").get();
  /* A row is seeded by the schema, but a database restored from an older
     backup may predate it — so this never returns undefined. */
  return r || { id: 1, deduct_by_attendance: 0, day_basis: "month_days",
                half_day_factor: 0.5, leave_is_paid: 1 };
}

/** How many days one month's salary is spread over. */
function basisDays(month, s) {
  if (s.day_basis === "fixed_26") return 26;
  if (s.day_basis === "fixed_30") return 30;
  return daysInMonth(month);
}

/* ------------------------------------------------------------ attendance */

/**
 * Counted days for one employee in one month.
 *
 * Only rows that exist are counted. See the note at the top: a day nobody
 * marked is not an absence.
 */
function attendanceSummary(employeeId, month) {
  const { from, to } = monthRange(month);
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS n
      FROM attendance
     WHERE employee_id = ? AND date >= ? AND date <= ?
     GROUP BY status
  `).all(employeeId, from, to);

  const out = { present: 0, absent: 0, half: 0, leave: 0, marked: 0 };
  for (const r of rows) {
    if (out[r.status] === undefined) continue;      /* unknown status ignored */
    out[r.status] = r.n;
    out.marked += r.n;
  }
  return out;
}

/**
 * What attendance costs the employee this month.
 *
 * Returns 0 whenever the shop has not switched the rule on, and says so
 * in `applied` — the screens print the workings, and "0 because it is
 * switched off" is a different sentence from "0 because they were here
 * every day".
 */
function attendanceDeduction(emp, month, s, summary) {
  const att = summary || attendanceSummary(emp.id, month);
  const days = basisDays(month, s);
  const perDay = days > 0 ? Number(emp.monthly_salary || 0) / days : 0;

  if (!s.deduct_by_attendance) {
    return { applied: false, amount: 0, perDay: round2(perDay), days,
             absentDays: att.absent, halfDays: att.half, leaveDays: att.leave,
             unpaidLeave: 0 };
  }

  const unpaidLeave = s.leave_is_paid ? 0 : att.leave;
  const halfCost = att.half * perDay * (1 - Number(s.half_day_factor || 0.5));
  const amount = (att.absent + unpaidLeave) * perDay + halfCost;

  return { applied: true, amount: round2(amount), perDay: round2(perDay), days,
           absentDays: att.absent, halfDays: att.half, leaveDays: att.leave,
           unpaidLeave };
}

/* ------------------------------------------------------------ money sums */

function sumFor(table, employeeId, month) {
  const { from, to } = monthRange(month);
  const r = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n
      FROM ${table}
     WHERE employee_id = ? AND voided = 0 AND date >= ? AND date <= ?
  `).get(employeeId, from, to);
  return { total: round2(r.total || 0), count: r.n || 0 };
}

/** Deductions and payments carry their payroll month rather than a date. */
function sumByMonth(table, employeeId, month) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS n
      FROM ${table}
     WHERE employee_id = ? AND voided = 0 AND month = ?
  `).get(employeeId, month);
  return { total: round2(r.total || 0), count: r.n || 0 };
}

/* ------------------------------------------------------- the whole month */

/**
 * Everything about one employee in one month, with the workings.
 *
 * `workings` is returned so a screen can SHOW how a figure was reached.
 * A shopkeeper who cannot see why the number is what it is will not trust
 * it, and an unexplained payroll figure is one they will recompute on
 * paper anyway.
 */
function employeeMonth(employeeId, month) {
  const emp = db.prepare("SELECT * FROM employees WHERE id = ?").get(employeeId);
  if (!emp) return null;

  const s = settings();
  const att = attendanceSummary(employeeId, month);
  const ded = attendanceDeduction(emp, month, s, att);

  const gross     = round2(Number(emp.monthly_salary || 0));
  const kharchi   = sumFor("kharchi_transactions", employeeId, month);
  const advances  = sumFor("salary_advances", employeeId, month);
  const other     = sumByMonth("salary_deductions", employeeId, month);
  const paid      = sumByMonth("salary_payments", employeeId, month);
  const expenses  = sumByMonth("employee_expenses", employeeId, month);

  /* What is still owed. Kharchi and advances belong here because they are
     salary already handed over. */
  const netPayable = round2(gross - ded.amount - kharchi.total - advances.total - other.total);
  const remaining  = round2(netPayable - paid.total);

  /* What the employee COSTS. Salary plus anything spent on top of it, and
     deliberately NOT kharchi or advances — see the header. */
  const totalCost  = round2(gross + expenses.total);

  const status = paid.total <= 0 ? "Unpaid"
               : remaining > 0.5 ? "Partially Paid"
               : "Paid";

  return {
    employee: {
      id: emp.id, name: emp.name, mobile: emp.mobile, job_role: emp.job_role,
      joining_date: emp.joining_date, salary_type: emp.salary_type, active: emp.active
    },
    month,
    gross,
    attendance: att,
    attendanceDeduction: ded,
    kharchi:    kharchi.total,   kharchiCount:  kharchi.count,
    advances:   advances.total,  advanceCount:  advances.count,
    deductions: other.total,     deductionCount: other.count,
    paid:       paid.total,      paymentCount:  paid.count,
    expenses:   expenses.total,  expenseCount:  expenses.count,
    netPayable,
    remaining,
    totalCost,
    status,
    /* Shown on screen so the arithmetic is never a black box. */
    workings: {
      payable: [
        { label: "Monthly salary",        amount: gross,            sign: "+" },
        { label: ded.applied ? "Attendance deduction"
                             : "Attendance deduction (switched off)",
                                          amount: ded.amount,       sign: "-" },
        { label: "Kharchi taken",         amount: kharchi.total,    sign: "-" },
        { label: "Advances",              amount: advances.total,   sign: "-" },
        { label: "Other deductions",      amount: other.total,      sign: "-" },
        { label: "Net salary payable",    amount: netPayable,       sign: "=" },
        { label: "Already paid",          amount: paid.total,       sign: "-" },
        { label: "Remaining",             amount: remaining,        sign: "=" }
      ],
      cost: [
        { label: "Monthly salary",        amount: gross,            sign: "+" },
        { label: "Employer expenses",     amount: expenses.total,   sign: "+" },
        { label: "Total employee cost",   amount: totalCost,        sign: "=" },
        { label: "Kharchi is NOT added — it is salary paid early",
                                          amount: 0,                sign: "note" }
      ]
    }
  };
}

/* --------------------------------------------------------------- totals */

/** Every active employee's month, plus the shop's totals for it. */
function monthTotals(month, opts) {
  const includeInactive = !!(opts && opts.includeInactive);
  const emps = db.prepare(
    "SELECT id FROM employees" + (includeInactive ? "" : " WHERE active = 1") + " ORDER BY name"
  ).all();

  const rows = emps.map(e => employeeMonth(e.id, month)).filter(Boolean);
  const add = (k) => round2(rows.reduce((a, r) => a + Number(r[k] || 0), 0));

  return {
    month,
    employees: rows.length,
    totals: {
      salary:     add("gross"),
      kharchi:    add("kharchi"),
      advances:   add("advances"),
      deductions: add("deductions"),
      expenses:   add("expenses"),
      netPayable: add("netPayable"),
      paid:       add("paid"),
      outstanding: add("remaining"),
      /* salary + employer expenses. Kharchi is absent on purpose. */
      totalCost:  round2(add("gross") + add("expenses"))
    },
    rows
  };
}

/** Present / absent counts for one day, across the shop. */
function dayAttendance(date) {
  const emps = db.prepare("SELECT id, name FROM employees WHERE active = 1 ORDER BY name").all();
  const marks = db.prepare("SELECT employee_id, status, note FROM attendance WHERE date = ?").all(date);
  const by = new Map(marks.map(m => [m.employee_id, m]));
  const rows = emps.map(e => ({
    id: e.id, name: e.name,
    status: (by.get(e.id) || {}).status || "",
    note: (by.get(e.id) || {}).note || ""
  }));
  const count = (st) => rows.filter(r => r.status === st).length;
  return {
    date, rows,
    present: count("present"), absent: count("absent"),
    half: count("half"), leave: count("leave"),
    unmarked: rows.filter(r => !r.status).length,
    total: rows.length
  };
}

/** Kharchi per employee over any range — the weekly board is this with 7 days. */
function kharchiBoard(from, to) {
  const rows = db.prepare(`
    SELECT e.id, e.name,
           COALESCE(SUM(k.amount),0) AS total,
           COUNT(k.id)               AS n,
           MAX(k.date)               AS last_date
      FROM employees e
      LEFT JOIN kharchi_transactions k
        ON k.employee_id = e.id AND k.voided = 0 AND k.date >= ? AND k.date <= ?
     WHERE e.active = 1
     GROUP BY e.id
     ORDER BY total DESC, e.name
  `).all(from, to);

  return {
    from, to,
    rows: rows.map(r => ({ id: r.id, name: r.name, total: round2(r.total || 0),
                           count: r.n || 0, lastDate: r.last_date || "" })),
    total: round2(rows.reduce((a, r) => a + Number(r.total || 0), 0)),
    transactions: rows.reduce((a, r) => a + (r.n || 0), 0)
  };
}

/**
 * One employee's ledger over a range, as dated lines.
 *
 * Every line says which KIND it is, because "₹500" on its own tells a
 * shopkeeper nothing — kharchi taken and salary paid move money the same
 * direction but mean entirely different things.
 */
function ledger(employeeId, from, to) {
  const lines = [];
  const push = (kind, date, amount, label, extra) =>
    lines.push({ kind, date, amount: round2(amount), label, ...(extra || {}) });

  for (const r of db.prepare(
    "SELECT * FROM kharchi_transactions WHERE employee_id=? AND date>=? AND date<=? ORDER BY date"
  ).all(employeeId, from, to))
    push("Kharchi", r.date, r.amount, r.reason || "Kharchi",
         { method: r.method, by: r.recorded_by, voided: !!r.voided, id: r.id });

  for (const r of db.prepare(
    "SELECT * FROM salary_advances WHERE employee_id=? AND date>=? AND date<=? ORDER BY date"
  ).all(employeeId, from, to))
    push("Advance", r.date, r.amount, r.reason || "Advance",
         { method: r.method, by: r.recorded_by, voided: !!r.voided, id: r.id });

  for (const r of db.prepare(
    "SELECT * FROM salary_deductions WHERE employee_id=? AND date>=? AND date<=? ORDER BY date"
  ).all(employeeId, from, to))
    push("Deduction", r.date, r.amount, r.reason || "Deduction",
         { month: r.month, by: r.recorded_by, voided: !!r.voided, id: r.id });

  for (const r of db.prepare(
    "SELECT * FROM salary_payments WHERE employee_id=? AND date>=? AND date<=? ORDER BY date"
  ).all(employeeId, from, to))
    push("Salary Paid", r.date, r.amount, r.notes || ("Salary " + r.month),
         { method: r.method, month: r.month, by: r.recorded_by, voided: !!r.voided, id: r.id });

  for (const r of db.prepare(
    "SELECT * FROM employee_expenses WHERE employee_id=? AND date>=? AND date<=? ORDER BY date"
  ).all(employeeId, from, to))
    push("Expense", r.date, r.amount, r.category || r.note || "Expense",
         { month: r.month, by: r.recorded_by, voided: !!r.voided, id: r.id });

  lines.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return lines;
}

module.exports = {
  monthOf, monthRange, daysInMonth, settings, basisDays,
  attendanceSummary, attendanceDeduction,
  employeeMonth, monthTotals, dayAttendance, kharchiBoard, ledger
};
