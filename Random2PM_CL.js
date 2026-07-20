// ============================================================
//  Shelly 2PM — Alternating Switch Sequence with Overlap
//  Runs ONLY between 21:05 and 23:00 (device local time)
// ============================================================

var INTERVALS   = [2, 4, 6, 8, 9, 11, 13, 15]; // minutes
var TIME_START_H = 21, TIME_START_M = 5;
var TIME_END_H   = 23, TIME_END_M   = 0;

// ---- Runtime state ----
var intervals    = [];   // shuffled copy of INTERVALS
var step         = 0;    // current step index
var curSw        = -1;   // active switch (0 or 1)
var overlapTimer = -1;
var mainTimer    = -1;

// ============================================================
//  Helpers
// ============================================================

// Build a printable array string without JSON.stringify
function arrToStr(arr) {
  var s = "[";
  for (var i = 0; i < arr.length; i++) {
    if (i > 0) s += ", ";
    s += arr[i];
  }
  return s + "]";
}

// In-place Fisher-Yates shuffle (no .sort() needed)
function shuffle(arr) {
  var i, j, tmp;
  for (i = arr.length - 1; i > 0; i--) {
    j = Math.floor(Math.random() * (i + 1));
    tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// Alternate between 0 and 1
function otherSw(sw) {
  return (sw === 1) ? 0 : 1;
}

// Zero-pad a number to 2 digits for display
function pad2(n) {
  return (n < 10) ? "0" + n : "" + n;
}

// ============================================================
//  Cleanup — cancel all timers and turn off both switches
// ============================================================
function cleanup() {
  print("[CLEANUP] Cancelling timers and switching both outputs OFF.");
  if (overlapTimer !== -1) { Timer.clear(overlapTimer); overlapTimer = -1; }
  if (mainTimer    !== -1) { Timer.clear(mainTimer);    mainTimer    = -1; }
  Shelly.call("Switch.Set", {id: 0, on: false}, null);
  Shelly.call("Switch.Set", {id: 1, on: false}, null);
}

// ============================================================
//  Core sequence — runs one step at a time via timer callbacks
// ============================================================
function runStep() {

  // All steps finished?
  if (step >= intervals.length) {
    print("=== Sequence complete. All " + intervals.length + " steps done. ===");
    return;
  }

  var durSec = intervals[step] * 60;   // convert minutes → seconds
  var sw     = curSw;                  // snapshot for closure capture
  var nSw    = otherSw(sw);            // next switch
  var isLast = (step === intervals.length - 1);

  print(
    ">>> Step " + (step + 1) + "/" + intervals.length +
    " | Switch " + sw + " ON" +
    " | Duration: " + intervals[step] + " min (" + durSec + "s)" +
    (isLast ? " [LAST STEP]" : " | Next: Switch " + nSw)
  );

  // Turn ON the current switch for this step
  Shelly.call("Switch.Set", {id: sw, on: true}, null);

  if (!isLast) {
    // ---- Overlap timer: fires 2 s before the end ----
    overlapTimer = Timer.set(
      (durSec - 2) * 1000,
      false,
      function() {
        print(
          "[OVERLAP] Switch " + nSw + " ON — " +
          "both switches active for 2 seconds."
        );
        Shelly.call("Switch.Set", {id: nSw, on: true}, null);
      }
    );

    // ---- Main timer: fires at the end of this step ----
    mainTimer = Timer.set(
      durSec * 1000,
      false,
      function() {
        print(
          "[HANDOVER] Switch " + sw + " OFF — " +
          "Switch " + nSw + " continues."
        );
        Shelly.call("Switch.Set", {id: sw, on: false}, null);
        curSw = nSw;
        step++;
        runStep();       // advance to next step
      }
    );

  } else {
    // ---- Last step: no overlap, just turn off and finish ----
    mainTimer = Timer.set(
      durSec * 1000,
      false,
      function() {
        print("[LAST] Switch " + sw + " OFF. Sequence finished.");
        Shelly.call("Switch.Set", {id: sw, on: false}, null);
      }
    );
  }
}

// ============================================================
//  Entry point — time-check then start sequence
// ============================================================
function start() {
  print("=== Script starting. Checking device time... ===");

  Shelly.call("Sys.GetStatus", {}, function(res, code, msg) {

    // ---- Guard: RPC call failed ----
    if (code !== 0 || !res || !res.time) {
      print("ERROR: Could not read device time (code=" + code +
            ", msg=" + msg + "). Aborting.");
      return;
    }

    var timeStr = res.time;   // "HH:MM" local time from device
    var colon   = timeStr.indexOf(":");
    if (colon < 0) {
      print("ERROR: Unexpected time format: '" + timeStr + "'. Aborting.");
      return;
    }

    // Parse HH and MM manually (parseInt is mJS-safe but let's stay explicit)
    var hStr = timeStr.substring(0, colon);
    var mStr = timeStr.substring(colon + 1, colon + 3);
    var h = 0, m = 0, i;
    for (i = 0; i < hStr.length; i++) h = h * 10 + (hStr.charCodeAt(i) - 48);
    for (i = 0; i < mStr.length; i++) m = m * 10 + (mStr.charCodeAt(i) - 48);

    var nowMin   = h * 60 + m;
    var startMin = TIME_START_H * 60 + TIME_START_M;
    var endMin   = TIME_END_H   * 60 + TIME_END_M;

    print(
      "Device time : " + timeStr +
      " | Allowed window: " +
      pad2(TIME_START_H) + ":" + pad2(TIME_START_M) +
      " – " +
      pad2(TIME_END_H)   + ":" + pad2(TIME_END_M)
    );

    // ---- Time window check ----
    if (nowMin < startMin || nowMin >= endMin) {
      print("Outside allowed time window (" + timeStr + "). Script aborted.");
      return;
    }

    print("Time check PASSED. Setting up sequence...");

    // ---- Build and shuffle a fresh copy of INTERVALS ----
    intervals = [];
    for (var k = 0; k < INTERVALS.length; k++) {
      intervals.push(INTERVALS[k]);
    }
    shuffle(intervals);
    print("Shuffled intervals : " + arrToStr(intervals) + " (minutes)");

    // ---- Initialise state and kick off first step ----
    step  = 0;
    curSw = 1;    // sequence starts with Switch 1
    print("Starting with Switch " + curSw + ".");
    runStep();
  });
}

// ============================================================
start();
// ============================================================
