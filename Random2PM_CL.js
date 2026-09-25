// ============================================================
//  Shelly 2PM — Secuencia alternada de switches con solapamiento
//  Corre SOLO entre 21:05 y 23:00 (hora local del dispositivo)
// ============================================================

var INTERVALS    = [2, 4, 6, 8, 9, 11, 13, 15]; // minutos
var TIME_START_H = 21, TIME_START_M = 5;
var TIME_END_H   = 23, TIME_END_M   = 0;
var OVERLAP_SEC  = 2;

// ---- Estado en tiempo de ejecución ----
var intervals    = [];   // copia mezclada de INTERVALS
var step         = 0;    // índice del paso actual
var curSw        = -1;   // switch activo (0 o 1)
var overlapTimer = -1;
var mainTimer    = -1;
var sequenceActive = false;
var sequenceStartedToday = false;
var ownScriptComponent = "script:" + Shelly.getCurrentScriptId();

// ============================================================
//  Funciones auxiliares
// ============================================================

// Convierte un array a string imprimible (sin JSON.stringify)
function arrToStr(arr) {
  var s = "[";
  for (var i = 0; i < arr.length; i++) {
    if (i > 0) s += ", ";
    s += arr[i];
  }
  return s + "]";
}

// Fisher-Yates in-place (sin necesidad de .sort())
function shuffle(arr) {
  var i, j, tmp;
  for (i = arr.length - 1; i > 0; i--) {
    j = Math.floor(Math.random() * (i + 1));
    tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

// Alterna entre 0 y 1
function otherSw(sw) {
  return (sw === 1) ? 0 : 1;
}

// Rellena con cero a la izquierda para mostrar 2 dígitos
function pad2(n) {
  return (n < 10) ? "0" + n : "" + n;
}

// Segundos desde medianoche local; null si la hora aún no está disponible.
function localSeconds() {
  var sys = Shelly.getComponentStatus("sys");
  if (!sys || typeof sys.time !== "string") return null;
  var colon = sys.time.indexOf(":");
  if (colon < 1) return null;
  var h = parseInt(sys.time.slice(0, colon), 10);
  var m = parseInt(sys.time.slice(colon + 1, colon + 3), 10);
  if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  var sec = (typeof sys.unixtime === "number" && sys.unixtime > 0) ? sys.unixtime % 60 : 0;
  return h * 3600 + m * 60 + sec;
}

function secondsRemaining() {
  var now = localSeconds();
  var start = (TIME_START_H * 60 + TIME_START_M) * 60;
  var end = (TIME_END_H * 60 + TIME_END_M) * 60;
  if (now === null || now < start || now >= end) return 0;
  return end - now;
}

function setSwitch(id, on) {
  Shelly.call("Switch.Set", { id: id, on: on }, function (res, code, msg) {
    if (code !== 0) {
      print("ERROR Switch.Set switch " + id + " " + (on ? "ON" : "OFF") +
            " (" + code + "): " + msg);
    }
  });
}

// ============================================================
//  Limpieza — cancela timers y apaga ambos switches
// ============================================================
function cleanup() {
  print("[LIMPIEZA] Cancelando timers y apagando ambas salidas.");
  if (overlapTimer !== -1) { Timer.clear(overlapTimer); overlapTimer = -1; }
  if (mainTimer    !== -1) { Timer.clear(mainTimer);    mainTimer    = -1; }
  setSwitch(0, false);
  setSwitch(1, false);
  sequenceActive = false;
}

// ============================================================
//  Secuencia principal — un paso a la vez vía timers
// ============================================================
function runStep() {

  var remaining = secondsRemaining();
  if (remaining <= 0) {
    print("Fin de la ventana horaria. Apagando ambas salidas.");
    cleanup();
    return;
  }

  if (step >= intervals.length) {
    print("=== Secuencia completa. Los " + intervals.length + " pasos terminaron. ===");
    cleanup();
    return;
  }

  var plannedSec = intervals[step] * 60;
  var durSec = Math.min(plannedSec, remaining); // no cruzar el cierre
  var truncated = durSec < plannedSec;
  var sw     = curSw;                  // snapshot para el closure
  var nSw    = otherSw(sw);            // siguiente switch
  var isLast = (step === intervals.length - 1);

  print(
    ">>> Paso " + (step + 1) + "/" + intervals.length +
    " | Switch " + sw + " ON" +
    " | Duración: " + intervals[step] + " min (" + durSec + "s)" +
    (isLast ? " [ÚLTIMO PASO]" : " | Siguiente: Switch " + nSw)
  );

  setSwitch(sw, true);

  if (!isLast && !truncated && durSec > OVERLAP_SEC) {
    // ---- Timer de solapamiento: dispara 2s antes del final ----
    overlapTimer = Timer.set(
      (durSec - OVERLAP_SEC) * 1000,
      false,
      function() {
        overlapTimer = -1;
        if (secondsRemaining() <= 0) {
          cleanup();
          return;
        }
        print("[SOLAPAMIENTO] Switch " + nSw + " ON — ambos switches activos por 2 segundos.");
        setSwitch(nSw, true);
      }
    );

    // ---- Timer principal: dispara al final de este paso ----
    mainTimer = Timer.set(
      durSec * 1000,
      false,
      function() {
        mainTimer = -1;
        if (truncated || secondsRemaining() <= 0) {
          print("Fin de la ventana horaria. Apagando ambas salidas.");
          cleanup();
          return;
        }
        print("[RELEVO] Switch " + sw + " OFF — Switch " + nSw + " continúa.");
        setSwitch(sw, false);
        curSw = nSw;
        step++;
        runStep();
      }
    );

  } else if (!isLast) {
    // El margen hasta el cierre es menor que el solapamiento: terminar este
    // paso y apagar ambas salidas al llegar al límite de la ventana.
    mainTimer = Timer.set(durSec * 1000, false, function() {
      mainTimer = -1;
      cleanup();
    });
  } else {
    // ---- Último paso: sin solapamiento, solo apagar y terminar ----
    mainTimer = Timer.set(
      durSec * 1000,
      false,
      function() {
        mainTimer = -1;
        print("[FINAL] Switch " + sw + " OFF. Secuencia terminada.");
        setSwitch(sw, false);
        sequenceActive = false;
      }
    );
  }
}

// ============================================================
//  Manejador de evento de parada externa
// ============================================================
//  Captura eventos de "script detenido" a nivel de dispositivo
//  (ej. detenido desde la app o vía RPC) para apagar ambos
//  switches y cancelar los timers pendientes.
// ============================================================
Shelly.addEventHandler(function(event) {
  if (!event) return;

  if (event.component === ownScriptComponent && event.event === "stopped") {
    print("Evento externo 'stopped' recibido. Ejecutando limpieza.");
    cleanup();
  }
});

// ============================================================
//  Planificador diario — espera a la hora de inicio y reinicia al cierre
// ============================================================
function watchdogTick() {
  var now = localSeconds();
  if (now === null) {
    print("Hora local no disponible; se reintentará en el siguiente ciclo.");
    return;
  }

  var start = (TIME_START_H * 60 + TIME_START_M) * 60;
  var end = (TIME_END_H * 60 + TIME_END_M) * 60;
  if (now >= end) {
    if (sequenceActive) {
      print("Fin de la ventana horaria; apagando las dos salidas.");
      cleanup();
    }
    if (sequenceStartedToday) {
      sequenceStartedToday = false;
      print("Estado diario reiniciado para la próxima ejecución.");
    }
    return;
  }

  if (now < start || sequenceStartedToday) return;

  print("Ventana activa. Preparando la secuencia diaria...");
  intervals = [];
  for (var k = 0; k < INTERVALS.length; k++) intervals.push(INTERVALS[k]);
  shuffle(intervals);
  print("Intervalos mezclados: " + arrToStr(intervals) + " (minutos)");

  step = 0;
  curSw = 1;
  sequenceStartedToday = true;
  sequenceActive = true;
  print("Iniciando con Switch " + curSw + ".");
  runStep();
}

// ============================================================
print("Script Shelly listo; comprobación diaria cada minuto.");
watchdogTick();
Timer.set(60 * 1000, true, watchdogTick);
// ========================================================
