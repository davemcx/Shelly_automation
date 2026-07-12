// =============================================
// Configuración - Modifica aquí los parámetros
// =============================================
var SWITCH_ID = 2;

var ON_TIME_MIN_RANGE  = [7, 8];   // [mínimo, máximo] minutos de encendido
var OFF_TIME_SEC_RANGE = [20, 30]; // [mínimo, máximo] segundos de apagado

var MAX_RETRIES = 5;      // Máximo de reintentos consecutivos ante error
var RETRY_DELAY_MS = 10000;

// =============================================
// Control del ciclo
// =============================================
var cycleRunning = true;  // Cambia a false para detener el ciclo

function stopCycle() {
  cycleRunning = false;
  log("Ciclo detenido manualmente.");
  setSwitch(false, null); // apagado de seguridad inmediato
}

// =============================================
// Helpers
// =============================================
function log() {
  var args = Array.prototype.slice.call(arguments);
  print.apply(null, ["[" + JSON.stringify(new Date()) + "]"].concat(args));
}

// Número aleatorio entero entre min y max (inclusive)
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Si prefieres elegir SOLO entre valores fijos (comportamiento original):
// function randomFrom(arr) {
//   return arr[Math.floor(Math.random() * arr.length)];
// }

// Enciende/apaga con reintentos limitados. cb(success) al terminar.
function setSwitch(on, cb, attempt) {
  attempt = attempt || 0;

  Shelly.call("Switch.Set", { id: SWITCH_ID, on: on }, function (res, err_code, err_msg) {
    if (err_code !== 0) {
      if (attempt < MAX_RETRIES) {
        log("ERROR al " + (on ? "encender" : "apagar") + ":", err_msg,
            "| Reintento", attempt + 1, "de", MAX_RETRIES, "en", RETRY_DELAY_MS / 1000, "s");
        Timer.set(RETRY_DELAY_MS, false, function () {
          setSwitch(on, cb, attempt + 1);
        });
      } else {
        log("ERROR: se agotaron los reintentos al " + (on ? "encender" : "apagar") + ". Deteniendo ciclo.");
        cycleRunning = false;
        if (cb) cb(false);
      }
      return;
    }

    if (cb) cb(true);
  });
}

// =============================================
// Ciclo principal
// =============================================
function runCycle() {
  if (!cycleRunning) {
    log("Ciclo detenido. Script inactivo.");
    return;
  }

  setSwitch(true, function (ok) {
    if (!ok) return;

    var onMin = randomBetween(ON_TIME_MIN_RANGE[0], ON_TIME_MIN_RANGE[1]);
    var onMs = onMin * 60 * 1000;
    log("✔ Enchufe encendido por:", onMin, "minutos.");

    Timer.set(onMs, false, function () {
      if (!cycleRunning) {
        setSwitch(false, null);
        log("Ciclo detenido durante el encendido. Enchufe apagado por seguridad.");
        return;
      }

      setSwitch(false, function (ok) {
        if (!ok) return;

        var offSec = randomBetween(OFF_TIME_SEC_RANGE[0], OFF_TIME_SEC_RANGE[1]);
        var offMs = offSec * 1000;
        log("✔ Enchufe apagado por:", offSec, "segundos.");

        Timer.set(offMs, false, function () {
          log("↺ Reiniciando ciclo...");
          runCycle();
        });
      });
    });
  });
}

// =============================================
// Inicio del script
// =============================================
log("Script iniciado. Switch ID:", SWITCH_ID);
runCycle();
