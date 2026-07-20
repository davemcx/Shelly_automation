// Improved VentilationS.js
// - safer timers (null IDs, cleared on stop/fatal)
// - exponential backoff + jitter for retries
// - explicit startCycle() / stopCycle() API
// - config validation and clearer logging
// - prevents concurrent runs (running flag)

// ========================= CONFIG ===========================
var SWITCH_ID           = 2;                 // channel (0-based)
var ON_TIME_MIN_RANGE   = [7, 10];          // minutes [min, max]
var OFF_TIME_SEC_RANGE  = [20, 30];         // seconds [min, max]
var MAX_RETRIES         = 5;                // number of retry attempts
var RETRY_BASE_MS       = 10000;            // base retry delay (ms)
var ENABLE_JITTER       = true;             // add jitter to backoff
var AUTO_START          = false;            // set true only if immediate start desired
var VERBOSE             = true;             // toggle verbose logging
// ===========================================================

// Runtime state
var running      = false;
var timerOn      = null;   // timer that ends ON period
var timerOff     = null;   // timer that ends OFF period
var retryTimer   = null;   // for scheduled retry attempts
var currentRetry = 0;

// ------------------------- Helpers -------------------------
function nowIso() {
  try { return new Date().toISOString(); } catch (e) { return "" + Date.now(); }
}
function log(msg) { if (VERBOSE) print("[" + nowIso() + "] VentilationS: " + msg); }
function warn(msg) { print("[" + nowIso() + "] VentilationS WARN: " + msg); }
function err(msg)  { print("[" + nowIso() + "] VentilationS ERROR: " + msg); }

// inclusive random integer between min and max
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// compute exponential backoff delay with optional jitter
function backoffDelay(attempt) {
  // attempt 0 -> base, 1 -> base*2, 2 -> base*4, etc.
  var mult = Math.pow(2, attempt);
  var delay = RETRY_BASE_MS * mult;
  if (ENABLE_JITTER) {
    var jitter = Math.floor(Math.random() * (RETRY_BASE_MS / 2));
    delay = delay + jitter;
  }
  return delay;
}

// Validate configuration ranges at startup
function validateConfig() {
  if (!Array.isArray(ON_TIME_MIN_RANGE) || ON_TIME_MIN_RANGE.length !== 2) {
    throw new Error("ON_TIME_MIN_RANGE must be [min,max]");
  }
  if (!Array.isArray(OFF_TIME_SEC_RANGE) || OFF_TIME_SEC_RANGE.length !== 2) {
    throw new Error("OFF_TIME_SEC_RANGE must be [min,max]");
  }
  if (ON_TIME_MIN_RANGE[0] <= 0 || ON_TIME_MIN_RANGE[1] < ON_TIME_MIN_RANGE[0]) {
    throw new Error("ON_TIME_MIN_RANGE invalid");
  }
  if (OFF_TIME_SEC_RANGE[0] < 0 || OFF_TIME_SEC_RANGE[1] < OFF_TIME_SEC_RANGE[0]) {
    throw new Error("OFF_TIME_SEC_RANGE invalid");
  }
  if (MAX_RETRIES < 0) throw new Error("MAX_RETRIES must be >= 0");
}

// --------------------- Shelly call wrapper -------------------
// method: e.g. "Switch.Set"
// params: object
// onSuccess(result), onFatal() optional
function shellyCall(method, params, onSuccess, onFatal) {
  currentRetry = 0;

  function attempt() {
    Shelly.call(method, params, function(res, code, msg) {
      if (code === 0) {
        if (typeof onSuccess === "function") onSuccess(res);
        return;
      }
      // non-zero -> failure
      warn(method + " failed (attempt " + (currentRetry+1) + "/" + (MAX_RETRIES+1) +
           ") code=" + code + " msg=" + msg);
      if (currentRetry < MAX_RETRIES) {
        var delay = backoffDelay(currentRetry);
        log("Scheduling retry in " + delay + " ms");
        // Clear any previous retryTimer just in case
        if (retryTimer !== null) { Timer.clear(retryTimer); retryTimer = null; }
        retryTimer = Timer.set(delay, false, function() {
          retryTimer = null;
          currentRetry++;
          attempt();
        });
        return;
      }
      // exhausted retries
      err("Exhausted retries for " + method + ". Marking cycle stopped.");
      // mark stopped and call fatal handler
      running = false;
      cleanup(); // ensure outputs off and timers cleared
      if (typeof onFatal === "function") onFatal();
    });
  }

  attempt();
}

// ------------------------- Cleanup --------------------------
function clearIfTimer(ref) {
  if (ref !== null) {
    try { Timer.clear(ref); } catch (e) { /* ignore */ }
  }
}
function cleanup() {
  // clear all timers
  if (timerOn !== null)  { clearIfTimer(timerOn);  timerOn  = null; }
  if (timerOff !== null) { clearIfTimer(timerOff); timerOff = null; }
  if (retryTimer !== null){ clearIfTimer(retryTimer); retryTimer = null; }
  // ensure switch off
  Shelly.call("Switch.Set", { id: SWITCH_ID, on: false }, function(res, code, msg) {
    if (code !== 0) {
      warn("Failed to set switch OFF during cleanup: code=" + code + " msg=" + msg);
    } else {
      log("Switch " + SWITCH_ID + " confirmed OFF by cleanup.");
    }
  });
}

// -------------------- Cycle control logic -------------------
function runCycleIteration() {
  if (!running) {
    log("runCycleIteration aborted because script not running.");
    return;
  }

  log("Starting ON phase.");

  // Turn ON with retries
  shellyCall(
    "Switch.Set",
    { id: SWITCH_ID, on: true },
    function() { // onSuccess
      var onMin = randInt(ON_TIME_MIN_RANGE[0], ON_TIME_MIN_RANGE[1]);
      var onMs = onMin * 60 * 1000;
      log("Switch " + SWITCH_ID + " ON for " + onMin + " min (" + onMs + " ms).");

      // schedule the OFF transition
      if (timerOn !== null) { clearIfTimer(timerOn); timerOn = null; }
      timerOn = Timer.set(onMs, false, function() {
        timerOn = null;
        if (!running) { log("Stopped during ON; not proceeding to OFF."); return; }

        log("Starting OFF phase.");

        shellyCall(
          "Switch.Set",
          { id: SWITCH_ID, on: false },
          function() { // onSuccess of OFF
            var offSec = randInt(OFF_TIME_SEC_RANGE[0], OFF_TIME_SEC_RANGE[1]);
            var offMs  = offSec * 1000;
            log("Switch " + SWITCH_ID + " OFF for " + offSec + " s (" + offMs + " ms).");

            if (timerOff !== null) { clearIfTimer(timerOff); timerOff = null; }
            timerOff = Timer.set(offMs, false, function() {
              timerOff = null;
              if (!running) { log("Stopped during OFF; not restarting."); return; }
              log("OFF phase complete. Looping...");
              // Next iteration
              runCycleIteration();
            });

          }, // onSuccess of Switch.Set OFF
          function() { // onFatal for OFF
            err("Failed to turn switch OFF after ON phase. Manual intervention required.");
          }
        );

      }); // timerOn
    }, // onSuccess of Switch.Set ON
    function() { // onFatal for ON
      err("Failed to turn switch ON. Cycle stopped.");
    }
  );
}

// --------------------- Public API: start/stop ----------------
function startCycle() {
  try {
    validateConfig();
  } catch (e) {
    err("Configuration validation failed: " + e.message);
    return;
  }

  if (running) {
    log("startCycle(): already running; ignoring.");
    return;
  }
  running = true;
  log("startCycle(): running=true. Beginning cycle iterations.");
  runCycleIteration();
}

function stopCycle() {
  if (!running) {
    log("stopCycle(): not running; nothing to stop.");
  }
  running = false;
  log("stopCycle(): stopping and cleaning up.");
  // clear timers and ensure switch off
  cleanup();
}

// Auto-start optionally
if (AUTO_START) {
  startCycle();
} else {
  log("VentilationS loaded. Call startCycle() to start or stopCycle() to stop.");
}

// Expose functions to console (helpful for interactive device console)
global.startCycle = startCycle;
global.stopCycle  = stopCycle;
