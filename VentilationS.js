// ============================================================
// == SECTION 1: CONFIGURATION
// ============================================================

// Target switch output channel (0-based index on the device)
var SWITCH_ID = 2;

// ON duration range in MINUTES [min, max] — both inclusive
var ON_TIME_MIN_RANGE = [7, 8];

// OFF duration range in SECONDS [min, max] — both inclusive
var OFF_TIME_SEC_RANGE = [20, 30];

// Maximum number of consecutive retries on API call failure
var MAX_RETRIES = 5;

// Delay in milliseconds between retry attempts
var RETRY_DELAY_MS = 10000;

// Master cycle control flag — set to false via stopCycle() to halt
var cycleRunning = true;


// ============================================================
// == SECTION 2: HELPERS
// ============================================================

/**
 * log(msg)
 * Prints a timestamped message to the Shelly script console.
 * @param {string} msg - The message to print.
 */
function log(msg) {
  print("[" + Date.now() + "] " + msg);
}

/**
 * randomBetween(min, max)
 * Returns a random integer between min and max, both inclusive.
 * @param {number} min - Lower bound (inclusive).
 * @param {number} max - Upper bound (inclusive).
 * @returns {number}
 */
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


// ============================================================
// == SECTION 3: CONTROL
// ============================================================

/**
 * stopCycle()
 * Public function to safely halt the infinite cycle at any time.
 * Sets the master flag to false and immediately forces the switch OFF.
 * Call this from the Shelly Script console: stopCycle()
 */
function stopCycle() {
  cycleRunning = false;
  log("STOP: stopCycle() invoked. Halting cycle immediately.");

  // Immediate safety shutdown — no retry on this call by design
  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: false },
    function(result, err_code, err_msg) {
      if (err_code !== 0) {
        log("WARNING: Safety shutdown call failed (code " + err_code + "): " + err_msg);
        log("WARNING: Verify switch " + SWITCH_ID + " is physically OFF!");
      } else {
        log("STOP: Safety shutdown confirmed. Switch " + SWITCH_ID + " is OFF.");
      }
    }
  );
}

/**
 * shellyCall(method, params, onSuccess, onFatal, retryCount)
 * Shelly.call() wrapper with automatic retry and fatal-error handling.
 *
 * @param {string}   method     - RPC method name (e.g. "Switch.Set")
 * @param {object}   params     - RPC parameters object
 * @param {function} onSuccess  - Callback(result) invoked on success
 * @param {function} onFatal    - Callback() invoked when all retries exhausted
 * @param {number}   retryCount - Internal retry counter (omit on first call)
 */
function shellyCall(method, params, onSuccess, onFatal, retryCount) {
  // Default retryCount to 0 on the initial call
  if (retryCount === undefined) {
    retryCount = 0;
  }

  var attemptNum  = retryCount + 1;
  var totalAttempts = MAX_RETRIES + 1;

  Shelly.call(
    method,
    params,
    function(result, err_code, err_msg) {

      // ── SUCCESS PATH ──────────────────────────────────────
      if (err_code === 0) {
        if (typeof onSuccess === "function") {
          onSuccess(result);
        }
        return;
      }

      // ── ERROR PATH ────────────────────────────────────────
      log(
        "ERROR: " + method + " failed " +
        "(attempt " + attemptNum + "/" + totalAttempts + ")" +
        " | code: " + err_code +
        " | msg: " + err_msg
      );

      // ── RETRY if attempts remain ──────────────────────────
      if (retryCount < MAX_RETRIES) {
        log("RETRY: Waiting " + RETRY_DELAY_MS + "ms before retry...");
        Timer.set(
          RETRY_DELAY_MS,
          false,
          function() {
            shellyCall(method, params, onSuccess, onFatal, retryCount + 1);
          }
        );
        return;
      }

      // ── FATAL: all retries exhausted ──────────────────────
      log(
        "FATAL: All " + MAX_RETRIES + " retries exhausted for [" + method + "]. " +
        "Cycle halted to prevent damage."
      );
      cycleRunning = false;

      if (typeof onFatal === "function") {
        onFatal();
      }
    }
  );
}


// ============================================================
// == SECTION 4: MAIN CYCLE
// ============================================================

/**
 * runCycle()
 * Core recursive loop function.
 * Flow: CHECK FLAG → TURN ON → wait ON_TIME → TURN OFF → wait OFF_TIME → repeat
 */
function runCycle() {

  // ── Guard: abort if cycle was stopped ────────────────────
  if (!cycleRunning) {
    log("CYCLE: cycleRunning=false. runCycle() aborted.");
    return;
  }

  log("CYCLE: ======= Starting new ON/OFF iteration =======");

  // ── PHASE 1: Turn the switch ON ───────────────────────────
  shellyCall(
    "Switch.Set",
    { id: SWITCH_ID, on: true },

    // onSuccess — switch is now ON
    function(result) {
      var onMinutes = randomBetween(ON_TIME_MIN_RANGE[0], ON_TIME_MIN_RANGE[1]);
      var onMs      = onMinutes * 60 * 1000;

      log(
        "CYCLE: Switch " + SWITCH_ID + " is ON." +
        " ON duration: " + onMinutes + " min (" + onMs + " ms)."
      );

      // Wait for ON duration, then move to OFF phase
      Timer.set(
        onMs,
        false,
        function() {

          // Guard inside timer — cycle may have been stopped while waiting
          if (!cycleRunning) {
            log("CYCLE: Stopped during ON phase. Skipping OFF transition.");
            return;
          }

          log("CYCLE: ON phase complete. Switching OFF...");

          // ── PHASE 2: Turn the switch OFF ──────────────────
          shellyCall(
            "Switch.Set",
            { id: SWITCH_ID, on: false },

            // onSuccess — switch is now OFF
            function(result) {
              var offSeconds = randomBetween(OFF_TIME_SEC_RANGE[0], OFF_TIME_SEC_RANGE[1]);
              var offMs      = offSeconds * 1000;

              log(
                "CYCLE: Switch " + SWITCH_ID + " is OFF." +
                " OFF duration: " + offSeconds + " sec (" + offMs + " ms)."
              );

              // Wait for OFF duration, then restart the loop
              Timer.set(
                offMs,
                false,
                function() {

                  // Guard inside timer — cycle may have been stopped while waiting
                  if (!cycleRunning) {
                    log("CYCLE: Stopped during OFF phase. Not restarting.");
                    return;
                  }

                  log("CYCLE: OFF phase complete. Restarting cycle...");
                  runCycle(); // ← Tail-recursive restart
                }
              );
            },

            // onFatal for Switch OFF
            function() {
              log(
                "FATAL: Could not turn Switch " + SWITCH_ID + " OFF after ON phase. " +
                "Cycle halted. Manual intervention required!"
              );
            }
          );
        }
      );
    },

    // onFatal for Switch ON
    function() {
      log(
        "FATAL: Could not turn Switch " + SWITCH_ID + " ON. " +
        "Cycle halted."
      );
    }
  );
}


// ============================================================
// == SECTION 5: INITIALIZATION
// ============================================================

log("=== Randomized Cycle Script v1.0 Starting ===");
log(
  "CONFIG:" +
  " SwitchID="    + SWITCH_ID +
  " | ON="        + ON_TIME_MIN_RANGE[0]  + "-" + ON_TIME_MIN_RANGE[1]  + " min" +
  " | OFF="       + OFF_TIME_SEC_RANGE[0] + "-" + OFF_TIME_SEC_RANGE[1] + " sec" +
  " | MaxRetries=" + MAX_RETRIES +
  " | RetryDelay=" + RETRY_DELAY_MS + "ms"
);
log("INFO: Call stopCycle() from the console to safely halt at any time.");

runCycle();
