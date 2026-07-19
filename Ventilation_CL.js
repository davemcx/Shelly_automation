// ================================================================
//  Dynamic Duty Cycle Switch Controller
//  - ON time decreases linearly each cycle
//  - OFF time increases linearly each cycle
//  - Full safety, retry, and graceful-stop support
// ================================================================

// ---------------------------------------------------------------
// 1. CONFIGURATION
// ---------------------------------------------------------------
var SWITCH_ID       = 0;    // Relay channel to control
var INITIAL_ON_MIN  = 30;   // Starting ON duration (minutes)
var INITIAL_OFF_MIN = 1;    // Starting OFF duration (minutes)
var STEP_MIN        = 1;    // Linear step per cycle (minutes)
var MAX_RETRIES     = 2;    // RPC retry attempts before abort
var MAX_RUNTIME_MIN = 540;  // Hard safety ceiling (9 hours)

// ---------------------------------------------------------------
// STATE VARIABLES
// ---------------------------------------------------------------
var onMin           = INITIAL_ON_MIN;
var offMin          = INITIAL_OFF_MIN;
var cycleCount      = 0;
var currentTimer    = null;
var maxRuntimeTimer = null;
var isRunning       = false;
var isTerminating   = false;

// ================================================================
// 2. LOGGING UTILITY
// ================================================================
function log(level, msg) {
  print("[" + level + "] DutyCycle: " + msg);
}

// ================================================================
// 3. GRACEFUL TERMINATION
// ================================================================
function terminateScript(reason) {
  // Guard against re-entrant or duplicate calls
  if (isTerminating) {
    log("WARN", "terminateScript already in progress, ignoring re-entry.");
    return;
  }
  isTerminating = true;

  log("INFO", "--- Terminating --- Reason: " + reason);

  // Clear the cycle timer (ON or OFF phase)
  if (currentTimer !== null) {
    Timer.clear(currentTimer);
    currentTimer = null;
    log("INFO", "Cycle timer cleared.");
  }

  // Clear the global safety timer
  if (maxRuntimeTimer !== null) {
    Timer.clear(maxRuntimeTimer);
    maxRuntimeTimer = null;
    log("INFO", "Safety timer cleared.");
  }

  // Final safety measure: guarantee the switch ends in OFF state
  log("INFO", "Issuing final Switch OFF before exit...");
  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: false },
    function(res, err_code, err_msg) {
      if (err_code !== 0) {
        log("WARN", "Final Switch OFF failed (code=" + err_code + "): " + err_msg);
      } else {
        log("INFO", "Switch confirmed OFF. Safe to exit.");
      }
      die(); // Halt the script engine
    }
  );
}

// ================================================================
// 4. RPC RETRY WRAPPER
// ================================================================
//
//  callWithRetry(state, retriesLeft, onSuccess, onFailure)
//
//  Attempts Switch.Set up to (1 + MAX_RETRIES) times total.
//  A 500 ms back-off delay is inserted between each retry.
// ================================================================
function callWithRetry(state, retriesLeft, onSuccess, onFailure) {
  if (isTerminating) return;

  var label = state ? "ON" : "OFF";

  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: state },
    function(res, err_code, err_msg) {

      if (err_code === 0) {
        log("INFO", "Switch.Set -> " + label + " succeeded.");
        onSuccess();
        return;
      }

      // RPC returned a non-zero status
      log("WARN",
        "Switch.Set -> " + label + " failed " +
        "(code=" + err_code + ", msg=" + err_msg + "). " +
        "Retries left: " + retriesLeft
      );

      if (retriesLeft > 0) {
        // Back-off 500 ms then retry
        Timer.set(500, false, function() {
          callWithRetry(state, retriesLeft - 1, onSuccess, onFailure);
        });
      } else {
        log("ERROR", "Switch.Set -> " + label + " exhausted all retries.");
        onFailure();
      }
    }
  );
}

// ================================================================
// 5. CORE CYCLE LOGIC
// ================================================================
//
//  Sequence per cycle:
//    [Calculate times]
//    -> Switch ON  -> wait onMin  minutes
//    -> Switch OFF -> wait offMin minutes
//    -> cycleCount++ -> runCycle() (next iteration)
// ================================================================
function runCycle() {
  if (isTerminating) return;

  if (isRunning) {
    log("WARN", "runCycle invoked while already running — skipping duplicate call.");
    return;
  }

  // --- Recalculate times for this iteration ---
  onMin  = INITIAL_ON_MIN  - (cycleCount * STEP_MIN);
  offMin = INITIAL_OFF_MIN + (cycleCount * STEP_MIN);

  log("INFO",
    "=== Cycle " + cycleCount +
    " | ON=" + onMin + " min" +
    " | OFF=" + offMin + " min ==="
  );

  // --- Stop Conditions ---
  if (onMin <= 0) {
    terminateScript(
      "onMin reached " + onMin + " (<= 0) at cycle " + cycleCount
    );
    return;
  }
  if (offMin > INITIAL_ON_MIN) {
    terminateScript(
      "offMin (" + offMin + ") exceeded INITIAL_ON_MIN (" +
      INITIAL_ON_MIN + ") at cycle " + cycleCount
    );
    return;
  }

  isRunning = true;

  // ---- STEP 1: Turn Switch ON ----
  callWithRetry(
    true,
    MAX_RETRIES,

    // onSuccess for Switch ON
    function() {
      if (isTerminating) return;

      log("INFO", "Phase ON  started. Duration: " + onMin + " min.");

      currentTimer = Timer.set(
        onMin * 60 * 1000,  // ms
        false,              // one-shot
        function() {
          currentTimer = null;
          if (isTerminating) return;

          // ---- STEP 2: Turn Switch OFF ----
          callWithRetry(
            false,
            MAX_RETRIES,

            // onSuccess for Switch OFF
            function() {
              if (isTerminating) return;

              log("INFO", "Phase OFF started. Duration: " + offMin + " min.");

              currentTimer = Timer.set(
                offMin * 60 * 1000,  // ms
                false,               // one-shot
                function() {
                  currentTimer = null;
                  if (isTerminating) return;

                  // ---- STEP 3: Advance and recurse ----
                  log("INFO", "Cycle " + cycleCount + " completed.");
                  cycleCount++;
                  isRunning = false;
                  runCycle();          // tail-recursive entry for next cycle
                }
              );
            },

            // onFailure for Switch OFF
            function() {
              terminateScript(
                "Switch OFF RPC failed after all retries on cycle " + cycleCount
              );
            }
          );
        }
      );
    },

    // onFailure for Switch ON
    function() {
      terminateScript(
        "Switch ON RPC failed after all retries on cycle " + cycleCount
      );
    }
  );
}

// ================================================================
// 6. EXTERNAL STOP EVENT HANDLER
// ================================================================
//
//  Catches device-level "script stopped" events so that any
//  pending timer callbacks do not fire after the script has been
//  halted externally (e.g., via the app or RPC).
// ================================================================
Shelly.addEventHandler(function(event) {
  if (!event) return;

  // The component field is "script:N" for script events
  var isScriptEvent = (
    typeof event.component === "string" &&
    event.component.indexOf("script") === 0
  );

  if (isScriptEvent && event.event === "stopped") {
    log("INFO", "External 'stopped' event received. Clearing all timers.");

    if (currentTimer !== null) {
      Timer.clear(currentTimer);
      currentTimer = null;
    }
    if (maxRuntimeTimer !== null) {
      Timer.clear(maxRuntimeTimer);
      maxRuntimeTimer = null;
    }
  }
});

// ================================================================
// 7. INITIALIZATION
// ================================================================
log("INFO", "Booting Dynamic Duty Cycle Controller...");
log("INFO",
  "Config -> " +
  "SWITCH_ID="       + SWITCH_ID       + " | " +
  "INITIAL_ON="      + INITIAL_ON_MIN  + " min | " +
  "INITIAL_OFF="     + INITIAL_OFF_MIN + " min | " +
  "STEP="            + STEP_MIN        + " min | " +
  "MAX_RETRIES="     + MAX_RETRIES     + " | " +
  "MAX_RUNTIME="     + MAX_RUNTIME_MIN + " min"
);

// Verify the relay is present and responsive before doing anything
Shelly.call(
  "Switch.GetStatus",
  { id: SWITCH_ID },
  function(res, err_code, err_msg) {

    if (err_code !== 0) {
      log("ERROR",
        "Switch.GetStatus failed (code=" + err_code + "): " + err_msg +
        ". Cannot proceed — aborting."
      );
      die();
      return;
    }

    log("INFO",
      "Switch " + SWITCH_ID + " is responsive. " +
      "Current output: " + (res.output ? "ON" : "OFF")
    );

    // --- Start the global safety / watchdog timer ---
    maxRuntimeTimer = Timer.set(
      MAX_RUNTIME_MIN * 60 * 1000,  // ms
      false,                         // one-shot
      function() {
        maxRuntimeTimer = null;
        terminateScript(
          "MAX_RUNTIME_MIN ceiling reached (" + MAX_RUNTIME_MIN + " min)"
        );
      }
    );

    log("INFO", "Safety watchdog armed for " + MAX_RUNTIME_MIN + " min.");

    // --- Kick off the first duty cycle ---
    runCycle();
  }
);
