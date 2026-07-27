// ============================================================
//  SHELLY SHUTTER — ROLLER BLIND CONTROLLER
//  Compatible with: Shelly 2.5 / Shelly Plus 2PM (Cover mode)
//  Runtime: mJS (Mongoose JavaScript, Shelly Gen2/Gen3)
// ============================================================

// ============================================================
//  CONFIGURATION — Edit these values to customise behaviour
// ============================================================

var COVER_ID           = 0;        // Shutter component ID (usually 0)
var TIMEZONE_OFFSET_H  = 2;        // UTC offset in whole hours (e.g. 2 = UTC+2)
var CHECK_INTERVAL_MS  = 900000;   // Polling interval: 900 000 ms = 15 minutes

// Morning window  08:01 → 13:00   (opens 5 % → 40 %)
var W1_START_H  = 8;
var W1_START_M  = 1;
var W1_END_H    = 13;
var W1_END_M    = 0;
var W1_POS_FROM = 5;    // % at window start
var W1_POS_TO   = 40;   // % at window end

// Afternoon/Evening window  13:00 → 21:30   (opens 40 % → 75 %)
var W2_START_H  = 13;
var W2_START_M  = 0;
var W2_END_H    = 21;
var W2_END_M    = 30;
var W2_POS_FROM = 40;   // % at window start
var W2_POS_TO   = 75;   // % at window end

// Movement tolerance — skip command if |delta| <= this value (%)
var TOLERANCE   = 1;

// ============================================================
//  INTERNAL STATE — do not edit
// ============================================================

var morningCleared = false;   // tracks whether AM state was wiped today

// ============================================================
//  HELPERS
// ============================================================

// Returns { h, m, totalMin } in local time
function localTime() {
  var ts       = Sys.time() + TIMEZONE_OFFSET_H * 3600;
  var totalMin = Math.floor(ts / 60) % 1440;   // minutes elapsed since midnight
  return {
    h:        Math.floor(totalMin / 60),
    m:        totalMin % 60,
    totalMin: totalMin
  };
}

// Converts hours + minutes to a single integer minute-of-day
function toMin(h, m) {
  return h * 60 + m;
}

// Linear interpolation — returns a floored integer percentage
function linearPos(posFrom, posTo, elapsed, total) {
  if (total <= 0) return posFrom;
  return Math.floor(posFrom + (posTo - posFrom) * elapsed / total);
}

// ============================================================
//  MOVEMENT COMMAND
// ============================================================

function moveTo(target) {
  print("Calling Cover.GoToPosition → " + target + "%");
  Shelly.call(
    "Cover.GoToPosition",
    { id: COVER_ID, pos: target },
    function (res, errCode, errMsg) {
      if (errCode !== 0) {
        print("ERROR GoToPosition: code=" + errCode + " msg=" + errMsg);
      } else {
        print("OK — blind is moving to " + target + "%");
      }
    }
  );
}

// ============================================================
//  SAFETY CHECK + POSITION DECISION
// ============================================================

function evaluateAndMove(target) {
  Shelly.call(
    "Cover.GetStatus",
    { id: COVER_ID },
    function (res, errCode, errMsg) {

      // ── RPC-level error ──────────────────────────────────
      if (errCode !== 0 || res === null) {
        print("ERROR Cover.GetStatus: code=" + errCode + " msg=" + errMsg);
        return;
      }

      // ── Hardware safety errors ───────────────────────────
      // res.errors is a string array when faults are present
      // (obstruction, overpower, safety_switch, etc.)
      var errs = res.errors;
      if (typeof errs === "object" && errs !== null && errs.length > 0) {
        print("SAFETY ABORT — active errors detected, skipping movement.");
        for (var i = 0; i < errs.length; i++) {
          print("  fault: " + errs[i]);
        }
        return;
      }

      // ── Read current position ────────────────────────────
      var currentPos = res.current_pos;
      if (typeof currentPos !== "number") {
        print("ERROR — current_pos unavailable (calibration needed?).");
        return;
      }

      var delta = target - currentPos;
      print(
        "Current=" + currentPos + "%  Target=" + target +
        "%  Delta=" + delta + "%"
      );

      // ── One-way rule: only open further ─────────────────
      if (delta <= 0) {
        print("SKIP — target is not higher than current position.");
        return;
      }

      // ── Tolerance guard ──────────────────────────────────
      if (delta <= TOLERANCE) {
        print("SKIP — delta within tolerance (" + TOLERANCE + "%).");
        return;
      }

      // ── All checks passed: move ──────────────────────────
      moveTo(target);
    }
  );
}

// ============================================================
//  MAIN CONTROL LOOP
// ============================================================

function runCheck() {
  var t   = localTime();
  var now = t.totalMin;

  var w1Start = toMin(W1_START_H, W1_START_M);   // 481 min
  var w1End   = toMin(W1_END_H,   W1_END_M);     // 780 min
  var w2Start = toMin(W2_START_H, W2_START_M);   // 780 min
  var w2End   = toMin(W2_END_H,   W2_END_M);     // 1290 min

  var target   = -1;
  var elapsed  = 0;
  var total    = 0;

  // ── Morning window ─────────────────────────────────────
  if (now >= w1Start && now < w1End) {
    morningCleared = false;                        // still in AM window
    elapsed = now - w1Start;
    total   = w1End - w1Start;
    target  = linearPos(W1_POS_FROM, W1_POS_TO, elapsed, total);
    print(
      "Window: MORNING  time=" + t.h + ":" + (t.m < 10 ? "0" : "") + t.m +
      "  target=" + target + "%"
    );

  // ── Afternoon/Evening window ──────────────────────────
  } else if (now >= w2Start && now < w2End) {
    // Wipe morning state the first time we enter the PM window
    if (!morningCleared) {
      morningCleared = true;
      print("Morning baseline cleared — ready for tomorrow.");
    }
    elapsed = now - w2Start;
    total   = w2End - w2Start;
    target  = linearPos(W2_POS_FROM, W2_POS_TO, elapsed, total);
    print(
      "Window: AFTERNOON  time=" + t.h + ":" + (t.m < 10 ? "0" : "") + t.m +
      "  target=" + target + "%"
    );

  // ── Outside active hours ──────────────────────────────
  } else {
    // After the PM window ends, reset the morning flag for the next day
    if (now >= w2End && morningCleared) {
      morningCleared = false;
      print("PM window ended — state reset for next day.");
    }
    print(
      "Outside active windows (" + t.h + ":" +
      (t.m < 10 ? "0" : "") + t.m + "). No action."
    );
    return;
  }

  // ── Proceed to safety + position evaluation ────────────
  evaluateAndMove(target);
}

// ============================================================
//  ENTRY POINT
// ============================================================

print("=== Roller Blind Controller starting ===");
runCheck();                                        // immediate check on boot
Timer.set(CHECK_INTERVAL_MS, true, runCheck);      // repeat every 15 min
