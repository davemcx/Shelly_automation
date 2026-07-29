// =============================================================================
// Shelly 1 Mini Gen4 - Timed Relay Sequence Script
// Author: ShellyAI | Target: Shelly 1 Mini Gen4 (Gen4, mJS)
// =============================================================================
//
// HOW IT WORKS:
//   On script load, two CRON schedules are automatically created on the device:
//     • Weekdays (Mon–Fri) at 05:35 AM  → CRON: "0 35 5 * * 1,2,3,4,5"
//     • Weekends (Sat–Sun) at 08:30 AM  → CRON: "0 30 8 * * 6,0"
//
//   Each schedule calls startSequence() via Script.Eval.
//
// ── ALTERNATIVE: MANUAL SCHEDULE SETUP VIA WEB UI ────────────────────────────
//   If you prefer to create schedules manually instead of via code:
//   1. Open your browser → http://<device-ip> → "Schedules" tab
//   2. Click "Add Schedule" → select "CRON" mode
//   3. Weekday schedule:
//        CRON expression : 0 35 5 * * 1,2,3,4,5
//        Action          : Script → [this script] → Eval → startSequence();
//   4. Weekend schedule:
//        CRON expression : 0 30 8 * * 6,0
//        Action          : Script → [this script] → Eval → startSequence();
//   Then set CREATE_SCHEDULES = false below to skip auto-creation.
// ─────────────────────────────────────────────────────────────────────────────
//
// RELAY SEQUENCE (total ~123.5 seconds before final ON):
//   Step 1 : ON  1s  → OFF 0.5s
//   Step 2 : ON  2s  → OFF 0.5s
//   Step 3 : ON  4s  → OFF 0.5s
//   Step 4 : ON  8s  → OFF 0.5s
//   Step 5 : ON 16s  → OFF 0.5s
//   Step 6 : ON 32s  → OFF 0.5s
//   Step 7 : ON 60s  → OFF 0.5s
//   Step 8 : ON indefinitely ✓
// =============================================================================


// ── CONFIGURATION ─────────────────────────────────────────────────────────────

var RELAY_ID        = 0;     // Shelly 1 Mini Gen4 has one relay → ID 0
var OFF_PAUSE_MS    = 500;   // Pause between steps (ms)

// Set to false after the first successful run to prevent duplicate schedules.
// Schedules persist on the device and survive reboots.
var CREATE_SCHEDULES = true;

// CRON expressions (Shelly format: sec min hour dom month dow)
var CRON_WEEKDAYS = "0 35 5 * * 1,2,3,4,5"; // Mon–Fri 05:35
var CRON_WEEKENDS = "0 30 8 * * 6,0";        // Sat–Sun 08:30 (0 = Sunday)

// Sequence: ON durations in milliseconds (OFF_PAUSE_MS is appended after each)
var SEQUENCE = [1000, 2000, 4000, 8000, 16000, 32000, 60000];


// ── STATE ─────────────────────────────────────────────────────────────────────

var sequenceRunning = false;
var activeTimer     = null;


// ── RELAY CONTROL ─────────────────────────────────────────────────────────────

/**
 * setRelay(on)
 * Turns the relay ON (true) or OFF (false) using the Shelly RPC API.
 * Non-blocking — uses a callback to log any errors.
 */
function setRelay(on) {
  Shelly.call(
    "Switch.Set",
    { id: RELAY_ID, on: on },
    function(result, error_code, error_message) {
      if (error_code !== 0) {
        print("ERROR Switch.Set →", error_code, error_message);
      }
    }
  );
}


// ── SEQUENCE ENGINE ───────────────────────────────────────────────────────────

/**
 * runStep(stepIndex)
 * Executes one step of the relay sequence, then schedules the next.
 * Fully non-blocking — uses nested Timer.set calls (no loops, no sleep).
 *
 * @param {number} stepIndex - Current position in SEQUENCE array.
 */
function runStep(stepIndex) {
  // ── All steps done → turn ON permanently ──────────────────────────────────
  if (stepIndex >= SEQUENCE.length) {
    print("--- Sequence complete: relay ON indefinitely ---");
    setRelay(true);
    sequenceRunning = false;
    activeTimer     = null;
    return;
  }

  var onDuration = SEQUENCE[stepIndex];
  var stepNum    = stepIndex + 1;
  var totalSteps = SEQUENCE.length;

  print(
    "Step " + stepNum + "/" + totalSteps +
    " → ON for " + (onDuration / 1000) + "s"
  );

  // ── 1. Turn relay ON ───────────────────────────────────────────────────────
  setRelay(true);

  // ── 2. After onDuration ms → turn relay OFF ────────────────────────────────
  activeTimer = Timer.set(onDuration, false, function() {

    print(
      "Step " + stepNum + "/" + totalSteps +
      " → OFF for " + OFF_PAUSE_MS + "ms"
    );
    setRelay(false);

    // ── 3. After OFF_PAUSE_MS → advance to next step ─────────────────────────
    activeTimer = Timer.set(OFF_PAUSE_MS, false, function() {
      runStep(stepIndex + 1);
    });

  });
}

/**
 * startSequence()
 * Public entry point. Called by the CRON schedules via Script.Eval.
 * Guards against concurrent execution if already running.
 */
function startSequence() {
  if (sequenceRunning) {
    print("WARNING: Sequence already running — ignoring duplicate trigger.");
    return;
  }

  // Safety: clear any orphaned timer
  if (activeTimer !== null) {
    Timer.clear(activeTimer);
    activeTimer = null;
  }

  sequenceRunning = true;
  print("=== Relay sequence started ===");
  runStep(0);
}


// ── SCHEDULE CREATION ─────────────────────────────────────────────────────────

/**
 * scheduleExists(jobs, cron)
 * Checks whether a schedule with the given CRON string already exists.
 * Prevents duplicate schedule creation on script restarts.
 */
function scheduleExists(jobs, cron) {
  for (var i = 0; i < jobs.length; i++) {
    if (jobs[i].timespec === cron) {
      return true;
    }
  }
  return false;
}

/**
 * createSchedule(cron, label, scriptId)
 * Creates a persistent CRON schedule that calls startSequence()
 * in this script's context via Script.Eval.
 *
 * Schedules survive device reboots and script restarts automatically.
 */
function createSchedule(cron, label, scriptId) {
  Shelly.call(
    "Schedule.Create",
    {
      enable   : true,
      timespec : cron,
      calls    : [
        {
          method : "Script.Eval",
          params : {
            id   : scriptId,
            code : "startSequence();"  // Calls the function defined in this script
          }
        }
      ]
    },
    function(result, error_code, error_message) {
      if (error_code === 0) {
        print("Schedule created → " + label + " [Schedule ID: " + result.id + "]");
      } else {
        print("ERROR creating schedule '" + label + "' →", error_code, error_message);
      }
    }
  );
}

/**
 * initSchedules()
 * Lists existing schedules and creates missing ones.
 * Run only when CREATE_SCHEDULES = true.
 */
function initSchedules() {
  var scriptId = Shelly.getCurrentScriptId();

  Shelly.call(
    "Schedule.List",
    {},
    function(result, error_code, error_message) {

      if (error_code !== 0) {
        print("ERROR listing schedules →", error_code, error_message);
        return;
      }

      var jobs = result.jobs || [];

      // Weekdays: Mon–Fri at 05:35
      if (!scheduleExists(jobs, CRON_WEEKDAYS)) {
        createSchedule(CRON_WEEKDAYS, "Weekdays 05:35 (Mon-Fri)", scriptId);
      } else {
        print("Schedule already exists → Weekdays 05:35");
      }

      // Weekends: Sat–Sun at 08:30
      if (!scheduleExists(jobs, CRON_WEEKENDS)) {
        createSchedule(CRON_WEEKENDS, "Weekends 08:30 (Sat-Sun)", scriptId);
      } else {
        print("Schedule already exists → Weekends 08:30");
      }

    }
  );
}


// ── ENTRY POINT ───────────────────────────────────────────────────────────────

print("Script loaded. Relay sequence engine ready.");
print("Relay ID:", RELAY_ID, "| Steps:", SEQUENCE.length, "| OFF pause:", OFF_PAUSE_MS + "ms");

if (CREATE_SCHEDULES) {
  initSchedules();
} else {
  print("Schedule auto-creation is disabled (CREATE_SCHEDULES = false).");
}
