// =============================================================================
// Shelly Gen3 Cover – Gradual Shutter Position Script
// =============================================================================
// Goal: Gradually open the shutter across two daily time windows:
//   Window 1: 08:00 → 13:00  — from current position up to 30%
//   Window 2: 13:00 → 21:30  — from 30% up to 75%
//
// The script runs a check every 15 minutes and calculates the ideal
// target position at that moment using linear interpolation.
// =============================================================================

// --- Configuration -----------------------------------------------------------

var COVER_ID = 0; // Cover channel ID (0 for single-cover devices)

// Window 1: 08:00 to 13:00 → ramp from startPos (captured at 08:00) to 30%
var WIN1_START_HOUR   = 8;
var WIN1_START_MIN    = 0;
var WIN1_END_HOUR     = 13;
var WIN1_END_MIN      = 0;
var WIN1_TARGET_POS   = 30; // % open at end of Window 1

// Window 2: 13:00 to 21:30 → ramp from 30% to 75%
var WIN2_START_HOUR   = 13;
var WIN2_START_MIN    = 0;
var WIN2_END_HOUR     = 21;
var WIN2_END_MIN      = 30;
var WIN2_START_POS    = 30;  // % open at start of Window 2
var WIN2_TARGET_POS   = 75;  // % open at end of Window 2

// How often the script checks and adjusts position (milliseconds)
var CHECK_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Tolerance: don't send a command if already within ±1% of target
var POSITION_TOLERANCE = 1;

// --- State -------------------------------------------------------------------

// Captured starting position for Window 1 (read from device at window open)
var win1StartPos     = -1;   // -1 means "not yet captured"
var win1StartCaptured = false;

// =============================================================================
// HELPER: Convert hours + minutes to total minutes since midnight
// =============================================================================
function toMinutes(h, m) {
  return h * 60 + m;
}

// =============================================================================
// HELPER: Linear interpolation
// Returns the ideal position at elapsed/total progress through a range
//   startPos → endPos
// =============================================================================
function lerp(startPos, endPos, elapsed, total) {
  if (total <= 0) return endPos;
  var ratio = elapsed / total;
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  // Round to nearest integer — Cover.GoToPosition expects whole numbers
  return Math.round(startPos + ratio * (endPos - startPos));
}

// =============================================================================
// CORE: Determine the target position based on current time
// Returns -1 if outside both windows (no action needed)
// =============================================================================
function getTargetPosition(nowMin, currentPos) {

  var win1Start = toMinutes(WIN1_START_HOUR, WIN1_START_MIN); // 480
  var win1End   = toMinutes(WIN1_END_HOUR,   WIN1_END_MIN);   // 780
  var win2Start = toMinutes(WIN2_START_HOUR, WIN2_START_MIN); // 780
  var win2End   = toMinutes(WIN2_END_HOUR,   WIN2_END_MIN);   // 1290

  // --- Window 1: 08:00 – 13:00 ---
  if (nowMin >= win1Start && nowMin < win1End) {

    // Capture the shutter's actual position at the very start of Window 1
    if (!win1StartCaptured) {
      win1StartPos      = currentPos;
      win1StartCaptured = true;
      print("[W1] Captured start position: " + win1StartPos + "%");
    }

    var elapsed = nowMin - win1Start;
    var total   = win1End - win1Start; // 300 minutes
    var target  = lerp(win1StartPos, WIN1_TARGET_POS, elapsed, total);
    print("[W1] Now=" + nowMin + "min | Elapsed=" + elapsed + "min | Target=" + target + "%");
    return target;
  }

  // --- Window 2: 13:00 – 21:30 ---
  if (nowMin >= win2Start && nowMin < win2End) {

    // Reset W1 capture flag so it re-captures tomorrow
    win1StartCaptured = false;

    var elapsed2 = nowMin - win2Start;
    var total2   = win2End - win2Start; // 510 minutes
    var target2  = lerp(WIN2_START_POS, WIN2_TARGET_POS, elapsed2, total2);
    print("[W2] Now=" + nowMin + "min | Elapsed=" + elapsed2 + "min | Target=" + target2 + "%");
    return target2;
  }

  // Outside both windows — no movement
  return -1;
}

// =============================================================================
// CORE: Move the cover to targetPos (if not already there)
// =============================================================================
function moveCoverTo(targetPos) {
  // Get current status first so we only move if needed
  Shelly.call(
    "Cover.GetStatus",
    { id: COVER_ID },
    function(result, error_code, error_message) {

      if (error_code !== 0 || !result) {
        print("[ERROR] Cover.GetStatus failed: " + error_message);
        return;
      }

      var currentPos = result.current_pos;

      // current_pos may be null if cover is moving or uncalibrated
      if (currentPos === null || currentPos === undefined) {
        print("[WARN] current_pos unavailable — cover may be moving or uncalibrated.");
        return;
      }

      print("[INFO] Current position: " + currentPos + "% | Target: " + targetPos + "%");

      // Only send the command if we're meaningfully far from the target
      var diff = targetPos - currentPos;
      if (diff < 0) diff = -diff; // Math.abs alternative

      if (diff <= POSITION_TOLERANCE) {
        print("[INFO] Already within tolerance (" + POSITION_TOLERANCE + "%). No movement needed.");
        return;
      }

      // Only move the cover forward (open further) — never close it
      if (targetPos <= currentPos) {
        print("[INFO] Target ≤ current position. Skipping to avoid closing.");
        return;
      }

      print("[ACTION] Moving cover to " + targetPos + "%");
      Shelly.call(
        "Cover.GoToPosition",
        { id: COVER_ID, pos: targetPos },
        function(res, err_code, err_msg) {
          if (err_code !== 0) {
            print("[ERROR] Cover.GoToPosition failed: " + err_msg);
          } else {
            print("[OK] Cover moving to " + targetPos + "%");
          }
        }
      );
    }
  );
}

// =============================================================================
// CORE: Main tick — called every 15 minutes
// =============================================================================
function tick() {
  // Get current device time
  Shelly.call(
    "Sys.GetStatus",
    {},
    function(result, error_code, error_message) {

      if (error_code !== 0 || !result) {
        print("[ERROR] Sys.GetStatus failed: " + error_message);
        return;
      }

      // unixtime → local time-of-day in minutes
      // Note: Shelly local time uses the device's configured timezone
      var unixtime  = result.time; // seconds since epoch (local offset not applied here)

      // Use the human-readable time string (format "HH:MM") provided by Sys.GetStatus
      // result.time is actually the human-readable "HH:MM" string on Gen2/Gen3 devices
      var timeStr   = result.time; // e.g. "08:15"
      var colonIdx  = timeStr.indexOf(":");
      var hours     = JSON.parse(timeStr.substring(0, colonIdx));
      var mins      = JSON.parse(timeStr.substring(colonIdx + 1));
      var nowMin    = toMinutes(hours, mins);

      print("[TICK] Local time: " + timeStr + " (" + nowMin + " min since midnight)");

      // Get current cover position to feed into window calculations
      Shelly.call(
        "Cover.GetStatus",
        { id: COVER_ID },
        function(coverResult, coverErr, coverErrMsg) {

          if (coverErr !== 0 || !coverResult) {
            print("[ERROR] Cover.GetStatus in tick failed: " + coverErrMsg);
            return;
          }

          var currentPos = coverResult.current_pos;

          if (currentPos === null || currentPos === undefined) {
            print("[WARN] current_pos not available in tick.");
            return;
          }

          // Calculate where we should be right now
          var targetPos = getTargetPosition(nowMin, currentPos);

          if (targetPos < 0) {
            print("[INFO] Outside active windows. No action.");
            // Reset W1 capture at night so it re-captures fresh tomorrow
            if (nowMin < toMinutes(WIN1_START_HOUR, WIN1_START_MIN)) {
              win1StartCaptured = false;
            }
            return;
          }

          // Move to the calculated target
          moveCoverTo(targetPos);
        }
      );
    }
  );
}

// =============================================================================
// STARTUP
// =============================================================================
print("[STARTUP] Gradual Shutter Script loaded.");
print("[STARTUP] Window 1: 08:00–13:00 → up to 30%");
print("[STARTUP] Window 2: 13:00–21:30 → up to 75%");
print("[STARTUP] Check interval: every 15 minutes.");

// Run immediately on startup so we don't wait 15 min for first check
tick();

// Then repeat every 15 minutes
Timer.set(CHECK_INTERVAL_MS, true, tick);
