// --- Configuration & State ---
var BASE_INTERVALS = [2, 4, 6, 8, 9, 11, 13, 15];
var WIN_START = 21; // 21:00 (9 PM)
var WIN_END = 23;   // 23:00 (11 PM, exclusive)
var SWITCH_ID = 0;

var shuffledIntervals = [];
var currentIntervalIndex = -1;
var isCycleActive = false;
var cycleCompleteToday = false;
var activeTimerId = null;

// --- Helper Functions ---

// Manual Fisher-Yates Shuffle compatible with mJS
function shuffleIntervalsArray() {
  shuffledIntervals = [];
  // Deep copy manually since advanced array methods are missing
  for (var i = 0; i < BASE_INTERVALS.length; i++) {
    shuffledIntervals.push(BASE_INTERVALS[i]);
  }
  
  // Backwards loop shuffle
  for (var j = shuffledIntervals.length - 1; j > 0; j--) {
    var randIndex = Math.floor(Math.random() * (j + 1));
    var temp = shuffledIntervals[j];
    shuffledIntervals[j] = shuffledIntervals[randIndex];
    shuffledIntervals[randIndex] = temp;
  }
  print("Intervals shuffled for tonight: ", JSON.stringify(shuffledIntervals));
}

// Safely turns the relay ON or OFF with RPC error handling
function setRelayState(isOn) {
  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: isOn },
    function (result, error_code, error_msg) {
      if (error_code !== 0) {
        print("RPC Error (" + error_code + "): " + error_msg);
      }
    }
  );
}

// Cancels any ongoing phase timers safely
function clearActiveTimer() {
  if (activeTimerId !== null) {
    Timer.clear(activeTimerId);
    activeTimerId = null;
  }
}

// Safely extracts the current local hour from the system status
function getCurrentHour() {
  var sysStatus = Shelly.getComponentStatus("sys");
  if (sysStatus && sysStatus.time) {
    // Expected format "HH:MM"
    var timeParts = sysStatus.time.split(":");
    if (timeParts.length >= 1) {
      return JSON.parse(timeParts[0]);
    }
  }
  return -1; // Fallback failure state
}

// --- Cycle Execution Flow ---

function runNextPhase() {
  var currentHour = getCurrentHour();
  
  // Guard clause: Boundary enforcement
  if (currentHour < WIN_START || currentHour >= WIN_END) {
    print("Time window exited during execution. Aborting cycle.");
    abortCycle();
    return;
  }

  currentIntervalIndex++;

  // Check if all intervals are exhausted
  if (currentIntervalIndex >= shuffledIntervals.length) {
    print("All intervals exhausted. Nightly cycle complete.");
    setRelayState(false);
    isCycleActive = false;
    cycleCompleteToday = true;
    return;
  }

  // Phase 1: Turn Relay ON
  var onMinutes = shuffledIntervals[currentIntervalIndex];
  print("Starting Phase 1 (ON): Element " + currentIntervalIndex + " for " + onMinutes + " minutes.");
  setRelayState(true);

  clearActiveTimer();
  activeTimerId = Timer.set(onMinutes * 60 * 1000, false, function () {
    // Phase 2: Turn Relay OFF (Randomized Buffer Pause)
    var currentHourCheck = getCurrentHour();
    if (currentHourCheck < WIN_START || currentHourCheck >= WIN_END) {
      abortCycle();
      return;
    }

    // 50% probability calculation for 2 or 3 minutes
    var offMinutes = Math.random() < 0.5 ? 2 : 3;
    print("Starting Phase 2 (OFF Buffer): Pausing for " + offMinutes + " minutes.");
    setRelayState(false);

    clearActiveTimer();
    activeTimerId = Timer.set(offMinutes * 60 * 1000, false, function () {
      // Loop back to handle the next ON interval
      runNextPhase();
    });
  });
}

function abortCycle() {
  clearActiveTimer();
  setRelayState(false);
  isCycleActive = false;
}

// --- Watchdog Engine ---

function watchdogTick() {
  var hour = getCurrentHour();
  if (hour === -1) {
    print("Warning: Could not retrieve system time.");
    return;
  }

  // Check if inside the window
  if (hour >= WIN_START && hour < WIN_END) {
    if (!isCycleActive && !cycleCompleteToday) {
      print("Entering time window. Initializing nightly cycle.");
      shuffleIntervalsArray();
      currentIntervalIndex = -1;
      isCycleActive = true;
      runNextPhase();
    }
  } else {
    // Outside window: Reset flags for the next day
    if (cycleCompleteToday || isCycleActive) {
      print("Outside time window. Resetting daily tracking flags.");
      abortCycle();
      cycleCompleteToday = false;
    }
  }
}

// --- Initialization ---

print("Shelly Random Cycle Script Started.");
// Run immediate check upon startup
watchdogTick();
// Set up repeating 60-second watchdog routine
Timer.set(60 * 1000, true, watchdogTick);
