// ─── Configuración ─────────────────────────────────────────────
var SWITCH_ID           = 0;        // id del interruptor a controlar
var ZERO_DURATION_S      = 55;      // segundos en 0W antes de actuar
var OFF_DURATION_S       = 5 * 60;  // segundos que el enchufe permanece OFF (5 min)
var COOLDOWN_S           = 144 * 3600; // segundos entre acciones permitidas (144 h)
var POWER_THRESHOLD_W    = 0.5;     // potencia por debajo de la cual se considera "0W" (ruido del medidor)
var KVS_KEY              = "plug_last_action_state";
var CHECK_INTERVAL_S     = 5;       // intervalo de sondeo en segundos
var MAX_RESTORE_RETRIES  = 8;       // reintentos máximos al restaurar el ON
// ────────────────────────────────────────────────────────────────

var zeroSince      = null;   // ts unix cuando empezó la racha de 0W
var lastActionTs   = 0;      // ts unix de la última acción de apagado
var restoreAt      = 0;      // ts unix en el que se debe restaurar el ON
var actionPending  = false;  // true mientras el enchufe está OFF o volviendo a ON
var restoreRetries = 0;      // contador de reintentos de restauración

// ── Utilidades ───────────────────────────────────────────────

function now() {
  var sys = Shelly.getComponentStatus("sys");
  return sys ? sys.unixtime : 0;
}

function switchKey() {
  return "switch:" + SWITCH_ID;
}

// Guarda el estado persistente (ts de acción + momento de restauración)
function saveState(cb) {
  var payload = JSON.stringify({ lastActionTs: lastActionTs, restoreAt: restoreAt });
  Shelly.call("KVS.Set", { key: KVS_KEY, value: payload }, function (res, err_code, err_msg) {
    if (err_code !== 0) {
      print("Error al guardar estado en KVS:", err_msg);
    }
    if (cb) cb(err_code === 0);
  });
}

// ── Lógica principal ─────────────────────────────────────────

function checkPower() {
  if (actionPending) return;

  var t = now();

  // Respeta el cooldown de COOLDOWN_S
  if (t > 0 && t - lastActionTs < COOLDOWN_S) {
    if (zeroSince !== null) {
      var remaining = COOLDOWN_S - (t - lastActionTs);
      print("Cooldown activo. Restante:", Math.ceil(remaining / 3600), "h. Ignorando 0W.");
      zeroSince = null; // reinicia cualquier racha de 0W durante el cooldown
    }
    return;
  }

  var sw = Shelly.getComponentStatus(switchKey());
  if (!sw) return;

  // No iniciar el temporizador si el interruptor ya está apagado
  if (!sw.output) {
    zeroSince = null;
    return;
  }

  var power = (typeof sw.apower === "number") ? sw.apower : -1;

  if (power >= 0 && power <= POWER_THRESHOLD_W) {
    if (zeroSince === null) {
      zeroSince = t;
      print("~0W detectado (", power, "W ) — cuenta regresiva iniciada.");
    } else if (t - zeroSince >= ZERO_DURATION_S) {
      triggerOff(t);
    }
  } else {
    if (zeroSince !== null) {
      print("Potencia de nuevo en", power, "W — cuenta regresiva reiniciada.");
      zeroSince = null;
    }
  }
}

function triggerOff(t) {
  print("~0W sostenido por", ZERO_DURATION_S, "s → apagando por", OFF_DURATION_S / 60, "min.");
  actionPending = true; // bloquea checkPower mientras se confirma la acción
  zeroSince     = null;

  Shelly.call("Switch.Set", { id: SWITCH_ID, on: false }, function (res, err_code, err_msg) {
    if (err_code !== 0) {
      print("Error al apagar el enchufe:", err_msg, "— no se registra cooldown, se reintentará en el próximo sondeo.");
      actionPending = false; // libera el bloqueo si falló el apagado; no se guarda estado
      return;
    }

    // Solo al confirmar el apagado se registra la acción y el cooldown
    lastActionTs = t;
    restoreAt    = t + OFF_DURATION_S;
    saveState(function () {
      print("Enchufe apagado. Se restaurará en", OFF_DURATION_S / 60, "min.");
      restoreRetries = 0;
      scheduleRestore(OFF_DURATION_S);
    });
  });
}

function scheduleRestore(delaySeconds) {
  Timer.set(delaySeconds * 1000, false, function () {
    print("Restaurando el enchufe a ON.");
    Shelly.call("Switch.Set", { id: SWITCH_ID, on: true }, function (res, err_code, err_msg) {
      if (err_code !== 0) {
        restoreRetries++;
        if (restoreRetries > MAX_RESTORE_RETRIES) {
          print("Error al restaurar el enchufe tras", MAX_RESTORE_RETRIES, "intentos. Abandonando reintentos:", err_msg);
          actionPending = false; // evita que el script quede bloqueado para siempre
          return;
        }
        print("Error al restaurar el enchufe (intento", restoreRetries, "), reintentando en 10 s:", err_msg);
        Timer.set(10 * 1000, false, function () { scheduleRestore(0); });
        return;
      }
      actionPending  = false;
      restoreRetries = 0;
      print("Enchufe restaurado. Próxima acción permitida tras", COOLDOWN_S / 3600, "h.");
    });
  });
}

// ── Arranque: cargar estado persistido y comenzar el sondeo ────

Shelly.call("KVS.Get", { key: KVS_KEY }, function (res, err_code) {
  if (err_code === 0 && res && res.value) {
    var state = JSON.parse(res.value);
    lastActionTs = state.lastActionTs || 0;
    restoreAt    = state.restoreAt || 0;

    var t = now();

    // Si el enchufe debía seguir apagado (reinicio a mitad del OFF_DURATION_S)
    if (restoreAt > t) {
      var remainingOff = restoreAt - t;
      print("Reanudado durante periodo OFF. Restaurando en", remainingOff, "s.");
      actionPending = true;
      Shelly.call("Switch.Set", { id: SWITCH_ID, on: false }, function () {
        scheduleRestore(remainingOff);
      });
    } else {
      var diff = t - lastActionTs;
      if (diff < COOLDOWN_S) {
        print("Reanudado. Cooldown: ~", Math.ceil((COOLDOWN_S - diff) / 3600), "h restantes.");
      } else {
        print("Reanudado. Sin cooldown activo.");
      }
    }
  } else {
    print("No se encontró acción previa. Monitoreo inicia desde cero.");
  }

  Timer.set(CHECK_INTERVAL_S * 1000, true, checkPower);
  print("Script en ejecución. Sondeando cada", CHECK_INTERVAL_S, "s.");
});
