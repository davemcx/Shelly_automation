// Shelly: secuencia aleatoria diaria para un relé.
// Toda la actividad queda limitada a la ventana horaria configurada.

// ── Configuración ────────────────────────────────────────────────────────────
var BASE_INTERVALS = [2, 4, 6, 8, 9, 11, 13, 15]; // minutos ON
var OFF_INTERVALS  = [2, 3];                      // minutos OFF entre fases
var WIN_START_H     = 21;
var WIN_START_M     = 0;
var WIN_END_H       = 23;
var WIN_END_M       = 0; // exclusivo
var SWITCH_ID       = 0;
var WATCHDOG_MS     = 60 * 1000;

// ── Estado ───────────────────────────────────────────────────────────────────
var shuffledIntervals = [];
var currentIntervalIndex = -1;
var isCycleActive = false;
var cycleCompleteToday = false;
var activeTimerId = null;

// Devuelve segundos desde medianoche local; null si el reloj no está listo.
function getLocalSeconds() {
  var sys = Shelly.getComponentStatus("sys");
  if (!sys || typeof sys.time !== "string") return null;

  var colon = sys.time.indexOf(":");
  if (colon < 1) return null;
  var hour = parseInt(sys.time.slice(0, colon), 10);
  var minute = parseInt(sys.time.slice(colon + 1, colon + 3), 10);
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  var second = (typeof sys.unixtime === "number" && sys.unixtime > 0) ? sys.unixtime % 60 : 0;
  return hour * 3600 + minute * 60 + second;
}

function windowBounds() {
  return {
    start: (WIN_START_H * 60 + WIN_START_M) * 60,
    end: (WIN_END_H * 60 + WIN_END_M) * 60
  };
}

function secondsRemaining() {
  var now = getLocalSeconds();
  var bounds = windowBounds();
  if (now === null || now < bounds.start || now >= bounds.end) return 0;
  return bounds.end - now;
}

function shuffleIntervals() {
  shuffledIntervals = [];
  for (var i = 0; i < BASE_INTERVALS.length; i++) shuffledIntervals.push(BASE_INTERVALS[i]);
  for (var j = shuffledIntervals.length - 1; j > 0; j--) {
    var k = Math.floor(Math.random() * (j + 1));
    var tmp = shuffledIntervals[j];
    shuffledIntervals[j] = shuffledIntervals[k];
    shuffledIntervals[k] = tmp;
  }
  print("Intervalos mezclados:", JSON.stringify(shuffledIntervals));
}

function clearActiveTimer() {
  if (activeTimerId !== null) {
    Timer.clear(activeTimerId);
    activeTimerId = null;
  }
}

function setRelayState(isOn, callback) {
  Shelly.call("Switch.Set", { id: SWITCH_ID, on: isOn }, function (res, code, msg) {
    if (code !== 0) {
      print("ERROR Switch.Set (" + (isOn ? "ON" : "OFF") + "): " + code + " " + msg);
      if (callback) callback(false);
      return;
    }
    if (callback) callback(true);
  });
}

function finishCycle(completed) {
  clearActiveTimer();
  setRelayState(false);
  isCycleActive = false;
  if (completed) cycleCompleteToday = true;
}

function abortCycle(reason) {
  if (reason) print("Ciclo detenido: " + reason);
  finishCycle(false);
}

function runNextPhase() {
  activeTimerId = null;
  var remaining = secondsRemaining();
  if (remaining <= 0) {
    abortCycle("fin de la ventana horaria o reloj no disponible");
    return;
  }

  currentIntervalIndex++;
  if (currentIntervalIndex >= shuffledIntervals.length) {
    print("Todas las fases completadas.");
    finishCycle(true);
    return;
  }

  var onSeconds = Math.min(shuffledIntervals[currentIntervalIndex] * 60, remaining);
  var truncated = onSeconds < shuffledIntervals[currentIntervalIndex] * 60;
  print("Fase ON " + (currentIntervalIndex + 1) + "/" + shuffledIntervals.length +
        " por " + onSeconds + " s" + (truncated ? " (hasta el cierre)" : ""));

  setRelayState(true, function (ok) {
    if (!ok) {
      abortCycle("falló el encendido del relé");
      return;
    }
    activeTimerId = Timer.set(onSeconds * 1000, false, function () {
      activeTimerId = null;
      if (truncated || secondsRemaining() <= 0) {
        abortCycle("fin de la ventana horaria");
        return;
      }

      var offSeconds = OFF_INTERVALS[Math.floor(Math.random() * OFF_INTERVALS.length)] * 60;
      remaining = secondsRemaining();
      var plannedOffSeconds = offSeconds;
      offSeconds = Math.min(offSeconds, remaining);
      var offTruncated = offSeconds < plannedOffSeconds;

      setRelayState(false, function (offOk) {
        if (!offOk) {
          abortCycle("falló el apagado del relé");
          return;
        }
        activeTimerId = Timer.set(offSeconds * 1000, false, function () {
          activeTimerId = null;
          if (offTruncated || secondsRemaining() <= 0) {
            abortCycle("fin de la ventana horaria");
            return;
          }
          runNextPhase();
        });
      });
    });
  });
}

function watchdogTick() {
  var remaining = secondsRemaining();
  if (remaining <= 0) {
    if (isCycleActive || cycleCompleteToday) {
      print("Fuera de la ventana horaria; reiniciando estado diario.");
      abortCycle();
      cycleCompleteToday = false;
    }
    return;
  }

  if (!isCycleActive && !cycleCompleteToday) {
    print("Ventana activa: iniciando secuencia.");
    shuffleIntervals();
    currentIntervalIndex = -1;
    isCycleActive = true;
    runNextPhase();
  }
}

print("Controlador de ciclo aleatorio Shelly iniciado.");
watchdogTick();
Timer.set(WATCHDOG_MS, true, watchdogTick);
