const crypto = require("crypto");

function uid(prefix) {
  return prefix + "_" + crypto.randomBytes(6).toString("hex");
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { uid, todayStr, round2 };
