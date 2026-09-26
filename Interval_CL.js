// =============================================================================
// Secuencia temporizada ON/OFF para Shelly Plus Plug S.
// Gen2+ con scripting. Conserva las duraciones originales.
// =============================================================================

// ── Configuración ────────────────────────────────────────────────────────────
var SWITCH_ID = 0;
var STOP_FLAG_KEY = "stop_sequence";
var SEQUENCE = [
  { state: true,  durationMin: 15 },
  { state: false, durationMin: 10 },
  { state: true,  durationMin: 1  },
  { state: false, durationMin: 10 },
  { state: true,  durationMin: 15 },
  { state: false, durationMin: 10 },
  { state: true,  durationMin: 1  },
  { state: false, durationMin: 10 },
  { state: true,  durationMin: 15 },
  { state: false, durationMin: 10 },
  { state: true,  durationMin: 1  },
  { state: false, durationMin: 10 },
  { state: true,  durationMin: 10 }
];

// ── Estado ───────────────────────────────────────────────────────────────────
var currentStep = 0;
var activeTimer = null;
var isStopping = false;
var ownScriptComponent = "script:" + Shelly.getCurrentScriptId();

function log(level, message) {
  print("[" + level + "] Interval: " + message);
}

function clearActiveTimer() {
  if (activeTimer !== null) {
    Timer.clear(activeTimer);
    activeTimer = null;
  }
}

function totalDurationMin() {
  var total = 0;
  for (var i = 0; i < SEQUENCE.length; i++) total += SEQUENCE[i].durationMin;
  return total;
}

function validateSequence() {
  if (!SEQUENCE || SEQUENCE.length === 0) return "La secuencia está vacía.";
  for (var i = 0; i < SEQUENCE.length; i++) {
    var step = SEQUENCE[i];
    if (!step || typeof step.state !== "boolean" ||
        typeof step.durationMin !== "number" || isNaN(step.durationMin) || step.durationMin <= 0) {
      return "Paso de configuración no válido en la posición " + (i + 1) + ".";
    }
  }
  return null;
}

function setSwitch(on, callback) {
  Shelly.call("Switch.Set", { id: SWITCH_ID, on: on }, function (res, code, msg) {
    if (code !== 0) {
      log("ERROR", "Switch.Set " + (on ? "ON" : "OFF") + " falló (" + code + "): " + msg);
      if (callback) callback(false);
      return;
    }
    if (callback) callback(true);
  });
}

function clearStopFlag() {
  Shelly.call("KVS.Delete", { key: STOP_FLAG_KEY }, function (res, code, msg) {
    // El error de clave inexistente es normal al completar una ejecución.
    if (code !== 0) log("INFO", "La bandera KVS no necesitó limpieza: " + msg);
  });
}

function stopSequence(reason, shouldClearStopFlag) {
  if (isStopping) return;
  isStopping = true;
  clearActiveTimer();
  log("INFO", "Secuencia detenida: " + reason);

  setSwitch(false, function (ok) {
    if (ok) log("INFO", "Salida confirmada en OFF.");
    if (shouldClearStopFlag !== false) clearStopFlag();
    log("INFO", "No se programarán más pasos.");
  });
}

// Busca primero la clave: KVS.Get devuelve error cuando la clave no existe.
function checkStopFlag(callback) {
  Shelly.call("KVS.List", { match: STOP_FLAG_KEY }, function (result, code, msg) {
    if (code !== 0 || !result) {
      callback(false, "No se pudo consultar KVS: " + msg);
      return;
    }

    var keys = result.keys || {};
    if (!keys[STOP_FLAG_KEY]) {
      callback(true, false);
      return;
    }

    Shelly.call("KVS.Get", { key: STOP_FLAG_KEY }, function (item, getCode, getMsg) {
      if (getCode !== 0 || !item) {
        callback(false, "No se pudo leer la bandera de parada: " + getMsg);
        return;
      }
      callback(true, item.value === "true" || item.value === true);
    });
  });
}

function executeStep() {
  if (isStopping) return;

  checkStopFlag(function (ok, stopRequested) {
    if (isStopping) return;
    if (!ok) {
      // Ante una lectura KVS fallida, detener con salida segura.
      stopSequence(stopRequested, false);
      return;
    }
    if (stopRequested) {
      stopSequence("se recibió la bandera externa de parada");
      return;
    }
    if (currentStep >= SEQUENCE.length) {
      stopSequence("secuencia completada");
      return;
    }

    var step = SEQUENCE[currentStep];
    log("INFO", "Paso " + (currentStep + 1) + "/" + SEQUENCE.length +
        ": " + (step.state ? "ON" : "OFF") + " durante " + step.durationMin + " min.");

    setSwitch(step.state, function (switchOk) {
      if (isStopping) return;
      if (!switchOk) {
        stopSequence("falló el comando del paso " + (currentStep + 1));
        return;
      }

      currentStep++;
      activeTimer = Timer.set(step.durationMin * 60 * 1000, false, function () {
        activeTimer = null;
        executeStep();
      });
    });
  });
}

// Si se detiene desde la app/RPC, pedir el apagado seguro de la salida.
Shelly.addEventHandler(function (event) {
  if (!event || event.component !== ownScriptComponent || event.event !== "stopped") return;
  isStopping = true;
  clearActiveTimer();
  Shelly.call("Switch.Set", { id: SWITCH_ID, on: false }, function (res, code, msg) {
    if (code !== 0) log("ERROR", "No se pudo apagar al detener el script: " + msg);
  });
});

var configError = validateSequence();
if (configError) {
  stopSequence(configError);
} else {
  log("INFO", "Inicio. Duración total: " + totalDurationMin() + " min.");
  log("INFO", "Parada externa: Shelly.call('KVS.Set', {key:'" + STOP_FLAG_KEY + "', value:'true'}).");
  executeStep();
}
