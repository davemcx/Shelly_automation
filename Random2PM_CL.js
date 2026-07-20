// ============================================================
//  Shelly 2PM — Secuencia alternada de switches con solapamiento
//  Corre SOLO entre 21:05 y 23:00 (hora local del dispositivo)
// ============================================================

var INTERVALS    = [2, 4, 6, 8, 9, 11, 13, 15]; // minutos
var TIME_START_H = 21, TIME_START_M = 5;
var TIME_END_H   = 23, TIME_END_M   = 0;

// ---- Estado en tiempo de ejecución ----
var intervals    = [];   // copia mezclada de INTERVALS
var step         = 0;    // índice del paso actual
var curSw        = -1;   // switch activo (0 o 1)
var overlapTimer = -1;
var mainTimer    = -1;

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

// ============================================================
//  Limpieza — cancela timers y apaga ambos switches
// ============================================================
function cleanup() {
  print("[LIMPIEZA] Cancelando timers y apagando ambas salidas.");
  if (overlapTimer !== -1) { Timer.clear(overlapTimer); overlapTimer = -1; }
  if (mainTimer    !== -1) { Timer.clear(mainTimer);    mainTimer    = -1; }
  Shelly.call("Switch.Set", {id: 0, on: false}, null);
  Shelly.call("Switch.Set", {id: 1, on: false}, null);
}

// ============================================================
//  Secuencia principal — un paso a la vez vía timers
// ============================================================
function runStep() {

  if (step >= intervals.length) {
    print("=== Secuencia completa. Los " + intervals.length + " pasos terminaron. ===");
    return;
  }

  var durSec = intervals[step] * 60;   // minutos → segundos
  var sw     = curSw;                  // snapshot para el closure
  var nSw    = otherSw(sw);            // siguiente switch
  var isLast = (step === intervals.length - 1);

  print(
    ">>> Paso " + (step + 1) + "/" + intervals.length +
    " | Switch " + sw + " ON" +
    " | Duración: " + intervals[step] + " min (" + durSec + "s)" +
    (isLast ? " [ÚLTIMO PASO]" : " | Siguiente: Switch " + nSw)
  );

  Shelly.call("Switch.Set", {id: sw, on: true}, null);

  if (!isLast) {
    // ---- Timer de solapamiento: dispara 2s antes del final ----
    overlapTimer = Timer.set(
      (durSec - 2) * 1000,
      false,
      function() {
        print("[SOLAPAMIENTO] Switch " + nSw + " ON — ambos switches activos por 2 segundos.");
        Shelly.call("Switch.Set", {id: nSw, on: true}, null);
      }
    );

    // ---- Timer principal: dispara al final de este paso ----
    mainTimer = Timer.set(
      durSec * 1000,
      false,
      function() {
        print("[RELEVO] Switch " + sw + " OFF — Switch " + nSw + " continúa.");
        Shelly.call("Switch.Set", {id: sw, on: false}, null);
        curSw = nSw;
        step++;
        runStep();
      }
    );

  } else {
    // ---- Último paso: sin solapamiento, solo apagar y terminar ----
    mainTimer = Timer.set(
      durSec * 1000,
      false,
      function() {
        print("[FINAL] Switch " + sw + " OFF. Secuencia terminada.");
        Shelly.call("Switch.Set", {id: sw, on: false}, null);
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

  var isScriptEvent = (
    typeof event.component === "string" &&
    event.component.indexOf("script") === 0
  );

  if (isScriptEvent && event.event === "stopped") {
    print("Evento externo 'stopped' recibido. Ejecutando limpieza.");
    cleanup();
  }
});

// ============================================================
//  Punto de entrada — verifica la hora y arranca la secuencia
// ============================================================
function start() {
  print("=== Script iniciando. Verificando hora del dispositivo... ===");

  Shelly.call("Sys.GetStatus", {}, function(res, code, msg) {

    if (code !== 0 || !res || !res.time) {
      print("ERROR: No se pudo leer la hora del dispositivo (code=" + code +
            ", msg=" + msg + "). Abortando.");
      return;
    }

    var timeStr = res.time;   // "HH:MM" hora local del dispositivo
    var colon   = timeStr.indexOf(":");
    if (colon < 0) {
      print("ERROR: Formato de hora inesperado: '" + timeStr + "'. Abortando.");
      return;
    }

    // Parsear HH y MM manualmente
    var hStr = timeStr.substring(0, colon);
    var mStr = timeStr.substring(colon + 1, colon + 3);
    var h = 0, m = 0, i;
    for (i = 0; i < hStr.length; i++) h = h * 10 + (hStr.charCodeAt(i) - 48);
    for (i = 0; i < mStr.length; i++) m = m * 10 + (mStr.charCodeAt(i) - 48);

    var nowMin   = h * 60 + m;
    var startMin = TIME_START_H * 60 + TIME_START_M;
    var endMin   = TIME_END_H   * 60 + TIME_END_M;

    print(
      "Hora del dispositivo: " + timeStr +
      " | Ventana permitida: " +
      pad2(TIME_START_H) + ":" + pad2(TIME_START_M) +
      " – " +
      pad2(TIME_END_H)   + ":" + pad2(TIME_END_M)
    );

    if (nowMin < startMin || nowMin >= endMin) {
      print("Fuera de la ventana horaria permitida (" + timeStr + "). Script abortado.");
      return;
    }

    print("Verificación de hora OK. Preparando secuencia...");

    // ---- Construir y mezclar una copia nueva de INTERVALS ----
    intervals = [];
    for (var k = 0; k < INTERVALS.length; k++) {
      intervals.push(INTERVALS[k]);
    }
    shuffle(intervals);
    print("Intervalos mezclados: " + arrToStr(intervals) + " (minutos)");

    // ---- Inicializar estado y arrancar el primer paso ----
    step  = 0;
    curSw = 1;    // la secuencia empieza con el Switch 1
    print("Iniciando con Switch " + curSw + ".");
    runStep();
  });
}

// ============================================================
start();
// ============================================================
