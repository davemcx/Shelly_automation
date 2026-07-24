// =============================================================================
// Shelly Gen3 Cover – Posicionamiento gradual del toldo/persiana
// =============================================================================
// Ventana 1: 08:00 → 13:00 — desde la posición actual hasta 30%
// Ventana 2: 13:00 → 21:30 — desde 30% hasta 75%
// Revisa cada 15 minutos y calcula la posición objetivo por interpolación lineal.
// El estado de la Ventana 1 (posición capturada) se persiste en KVS por si el
// dispositivo se reinicia a mitad de la ventana.
// =============================================================================

// --- Configuración ------------------------------------------------------------

var COVER_ID = 0; // ID del canal de la persiana (0 si es un solo dispositivo)

var WIN1_START_HOUR = 8;
var WIN1_START_MIN  = 0;
var WIN1_END_HOUR    = 13;
var WIN1_END_MIN     = 0;
var WIN1_TARGET_POS  = 30; // % al final de la Ventana 1

var WIN2_START_HOUR = 13;
var WIN2_START_MIN  = 0;
var WIN2_END_HOUR    = 21;
var WIN2_END_MIN     = 30;
var WIN2_START_POS   = WIN1_TARGET_POS; // arranca donde terminó la Ventana 1
var WIN2_TARGET_POS  = 75;              // % al final de la Ventana 2

var CHECK_INTERVAL_MS  = 15 * 60 * 1000; // 15 minutos
var POSITION_TOLERANCE = 1;              // no mover si ya está a ±1% del objetivo

var KVS_KEY = "cover_win1_state"; // persistencia de la captura de la Ventana 1

// --- Estado ---------------------------------------------------------------

var win1StartPos      = -1;    // posición capturada al iniciar la Ventana 1
var win1StartCaptured  = false;

// Convierte horas + minutos a minutos totales desde medianoche
function toMinutes(h, m) {
  return h * 60 + m;
}

// Interpolación lineal: posición ideal según progreso (elapsed/total) entre startPos y endPos
function lerp(startPos, endPos, elapsed, total) {
  if (total <= 0) return endPos;
  var ratio = elapsed / total;
  if (ratio < 0) ratio = 0;
  if (ratio > 1) ratio = 1;
  return Math.round(startPos + ratio * (endPos - startPos));
}

// Guarda en KVS si ya se capturó la posición inicial de la Ventana 1 y cuál fue
function saveWin1State(cb) {
  var payload = JSON.stringify({ captured: win1StartCaptured, startPos: win1StartPos });
  Shelly.call("KVS.Set", { key: KVS_KEY, value: payload }, function(res, err_code, err_msg) {
    if (err_code !== 0) {
      print("[ERROR] KVS.Set falló: " + err_msg);
    }
    if (cb) cb(err_code === 0);
  });
}

// Cambia el estado de captura de la Ventana 1 y lo persiste
function setWin1Captured(captured, startPos) {
  win1StartCaptured = captured;
  win1StartPos      = (startPos === undefined) ? win1StartPos : startPos;
  saveWin1State();
}

// Determina la posición objetivo según la hora actual. -1 si está fuera de ambas ventanas.
function getTargetPosition(nowMin, currentPos) {

  var win1Start = toMinutes(WIN1_START_HOUR, WIN1_START_MIN);
  var win1End   = toMinutes(WIN1_END_HOUR,   WIN1_END_MIN);
  var win2Start = toMinutes(WIN2_START_HOUR, WIN2_START_MIN);
  var win2End   = toMinutes(WIN2_END_HOUR,   WIN2_END_MIN);

  // --- Ventana 1 ---
  if (nowMin >= win1Start && nowMin < win1End) {

    // Captura la posición real solo al inicio de la ventana (o al reanudar sin captura previa)
    if (!win1StartCaptured) {
      setWin1Captured(true, currentPos);
      print("[V1] Posición inicial capturada: " + win1StartPos + "%");
    }

    var elapsed = nowMin - win1Start;
    var total   = win1End - win1Start;
    var target  = lerp(win1StartPos, WIN1_TARGET_POS, elapsed, total);
    print("[V1] Ahora=" + nowMin + "min | Transcurrido=" + elapsed + "min | Objetivo=" + target + "%");
    return target;
  }

  // --- Ventana 2 ---
  if (nowMin >= win2Start && nowMin < win2End) {

    if (win1StartCaptured) {
      setWin1Captured(false); // para volver a capturar mañana
    }

    var elapsed2 = nowMin - win2Start;
    var total2   = win2End - win2Start;
    var target2  = lerp(WIN2_START_POS, WIN2_TARGET_POS, elapsed2, total2);
    print("[V2] Ahora=" + nowMin + "min | Transcurrido=" + elapsed2 + "min | Objetivo=" + target2 + "%");
    return target2;
  }

  return -1; // fuera de ambas ventanas
}

// Mueve la persiana a targetPos, solo si hace falta y solo hacia adelante (nunca cierra)
function moveCoverTo(targetPos) {
  Shelly.call(
    "Cover.GetStatus",
    { id: COVER_ID },
    function(result, error_code, error_message) {

      if (error_code !== 0 || !result) {
        print("[ERROR] Cover.GetStatus falló: " + error_message);
        return;
      }

      var currentPos = result.current_pos;

      // current_pos puede ser null si la persiana se está moviendo o no está calibrada
      if (currentPos === null || currentPos === undefined) {
        print("[AVISO] current_pos no disponible.");
        return;
      }

      print("[INFO] Posición actual: " + currentPos + "% | Objetivo: " + targetPos + "%");

      var diff = Math.abs(targetPos - currentPos);
      if (diff <= POSITION_TOLERANCE) {
        print("[INFO] Ya está dentro de la tolerancia. No se mueve.");
        return;
      }

      // Solo abrir más, nunca cerrar
      if (targetPos <= currentPos) {
        print("[INFO] Objetivo ≤ posición actual. Se omite para no cerrar.");
        return;
      }

      print("[ACCIÓN] Moviendo persiana a " + targetPos + "%");
      Shelly.call(
        "Cover.GoToPosition",
        { id: COVER_ID, pos: targetPos },
        function(res, err_code, err_msg) {
          if (err_code !== 0) {
            print("[ERROR] Cover.GoToPosition falló: " + err_msg);
          } else {
            print("[OK] Persiana moviéndose a " + targetPos + "%");
          }
        }
      );
    }
  );
}

// Ciclo principal, se ejecuta cada 15 minutos
function tick() {
  Shelly.call(
    "Sys.GetStatus",
    {},
    function(result, error_code, error_message) {

      if (error_code !== 0 || !result) {
        print("[ERROR] Sys.GetStatus falló: " + error_message);
        return;
      }

      // result.time llega como string "HH:MM" en hora local del dispositivo.
      // Se usa parseInt (no JSON.parse) porque "08", "05", etc. no son JSON válido.
      var timeStr  = result.time; // ej. "08:15"
      var colonIdx = timeStr.indexOf(":");
      var hours    = parseInt(timeStr.substring(0, colonIdx), 10);
      var mins     = parseInt(timeStr.substring(colonIdx + 1), 10);
      var nowMin   = toMinutes(hours, mins);

      print("[TICK] Hora local: " + timeStr + " (" + nowMin + " min desde medianoche)");

      Shelly.call(
        "Cover.GetStatus",
        { id: COVER_ID },
        function(coverResult, coverErr, coverErrMsg) {

          if (coverErr !== 0 || !coverResult) {
            print("[ERROR] Cover.GetStatus (tick) falló: " + coverErrMsg);
            return;
          }

          var currentPos = coverResult.current_pos;

          if (currentPos === null || currentPos === undefined) {
            print("[AVISO] current_pos no disponible en tick.");
            return;
          }

          var targetPos = getTargetPosition(nowMin, currentPos);

          if (targetPos < 0) {
            print("[INFO] Fuera de las ventanas activas. Sin acción.");
            if (win1StartCaptured && nowMin < toMinutes(WIN1_START_HOUR, WIN1_START_MIN)) {
              setWin1Captured(false); // reset nocturno para mañana
            }
            return;
          }

          moveCoverTo(targetPos);
        }
      );
    }
  );
}

// --- Arranque: cargar estado persistido antes de empezar a sondear ---------

Shelly.call("KVS.Get", { key: KVS_KEY }, function(res, err_code) {
  if (err_code === 0 && res && res.value) {
    var state = JSON.parse(res.value);
    win1StartCaptured = !!state.captured;
    win1StartPos      = (typeof state.startPos === "number") ? state.startPos : -1;
    if (win1StartCaptured) {
      print("[INICIO] Estado restaurado: Ventana 1 ya capturada en " + win1StartPos + "%");
    } else {
      print("[INICIO] Estado restaurado: Ventana 1 sin capturar.");
    }
  } else {
    print("[INICIO] Sin estado previo. Se capturará al entrar en la Ventana 1.");
  }

  print("[INICIO] Script de posicionamiento gradual cargado.");
  print("[INICIO] Ventana 1: 08:00–13:00 → hasta 30%");
  print("[INICIO] Ventana 2: 13:00–21:30 → hasta 75%");
  print("[INICIO] Intervalo de chequeo: 15 min.");

  tick(); // ejecuta de inmediato, sin esperar los primeros 15 min
  Timer.set(CHECK_INTERVAL_MS, true, tick);
});
