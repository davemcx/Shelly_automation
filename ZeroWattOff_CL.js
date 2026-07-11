// ─── Configuración ─────────────────────────────────────────────
var ZERO_DURATION_S  = 5;          // segundos en 0W antes de actuar
var OFF_DURATION_S   = 5 * 60;     // segundos que el enchufe permanece OFF (5 min)
var COOLDOWN_S       = 72 * 3600;  // segundos entre acciones permitidas (72 h)
var KVS_KEY          = "plug_last_action_state";
var CHECK_INTERVAL_S = 1;          // intervalo de sondeo en segundos
// ────────────────────────────────────────────────────────────────

var zeroSince     = null;  // ts unix cuando empezó la racha de 0W
var lastActionTs  = 0;     // ts unix de la última acción de apagado
var restoreAt     = 0;     // ts unix en el que se debe restaurar el ON
var actionPending = false; // true mientras el enchufe está OFF o volviendo a ON

// ── Utilidades ───────────────────────────────────────────────

function now() {
  var sys = Shelly.getComponentStatus("sys");
  return sys ? sys.unixtime : 0;
}

// Guarda el estado persistente (ts de acción + momento de restauración)
function saveState() {
  var payload = JSON.stringify({ lastActionTs: lastActionTs, restoreAt: restoreAt });
  Shelly.call("KVS.Set", { key: KVS_KEY, value: payload }, function (res, err_code, err_msg) {
    if (err_code !== 0) {
      print("Error al guardar estado en KVS:", err_msg);
    }
  });
}

// ── Lógica principal ─────────────────────────────────────────

function checkPower() {
  if (actionPending) return;

  var t = now();

  // Respeta el cooldown de 72 horas
  if (t > 0 && t - lastActionTs < COOLDOWN_S) {
    if (zeroSince !== null) {
      var remaining = COOLDOWN_S - (t - lastActionTs);
      print("Cooldown activo. Restante:", Math.ceil(remaining / 3600), "h. Ignorando 0W.");
      zeroSince = null; // reinicia cualquier racha de 0W durante el cooldown
    }
    return;
  }

  var sw = Shelly.getComponentStatus("switch:0");
  if (!sw) return;

  // No iniciar el temporizador si el interruptor ya está apagado
  if (!sw.output) {
    zeroSince = null;
    return;
  }

  var power = (typeof sw.apower === "number") ? sw.apower : -1;

  if (power === 0) {
    if (zeroSince === null) {
      zeroSince = t;
      print("0W detectado — cuenta regresiva iniciada.");
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
  print("0W sostenido por", ZERO_DURATION_S, "s → apagando por", OFF_DURATION_S / 60, "min.");
  actionPending = true;
  lastActionTs  = t;
  restoreAt     = t + OFF_DURATION_S;
  zeroSince     = null;
  saveState();

  Shelly.call("Switch.Set", { id: 0, on: false }, function (res, err_code, err_msg) {
    if (err_code !== 0) {
      print("Error al apagar el enchufe:", err_msg);
      actionPending = false; // libera el bloqueo si falló el apagado
      return;
    }
    print("Enchufe apagado. Se restaurará en", OFF_DURATION_S / 60, "min.");
    scheduleRestore(OFF_DURATION_S);
  });
}

function scheduleRestore(delaySeconds) {
  Timer.set(delaySeconds * 1000, false, function () {
    print("Restaurando el enchufe a ON.");
    Shelly.call("Switch.Set", { id: 0, on: true }, function (res, err_code, err_msg) {
      if (err_code !== 0) {
        print("Error al restaurar el enchufe, reintentando en 10 s:", err_msg);
        Timer.set(10 * 1000, false, function () { scheduleRestore(0); });
        return;
      }
      actionPending = false;
      print("Enchufe restaurado. Próxima acción permitida tras 72 h.");
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
      Shelly.call("Switch.Set", { id: 0, on: false }, function () {
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
