// ============================================================
// Shelly Shutter Gen3 | Horario diario de posición de cortina
// Formato CRON : "seg min hora dom mes dow"
// Zona horaria : usa la hora local configurada en el dispositivo
// ============================================================

var COVER_ID = 0; // ID del componente Cover (0 = única cortina)

// ── Función base: mueve la cortina a una posición y registra el resultado ──
function moveTo(pos, description) {
  console.log("Movimiento programado | " + description);

  Shelly.call(
    "Cover.GoTo",
    { id: COVER_ID, pos: pos },
    function (res, err_code, err_msg) {
      if (err_code !== 0) {
        console.log("ERROR Cover.GoTo [" + err_code + "]: " + err_msg);
      } else {
        console.log("Cover.GoTo " + pos + "% → aceptado");
      }
    }
  );
}

// ── Mueve la cortina a una posición ALEATORIA dentro de [min, max] ─────────
function moveToRandom(min, max, label) {
  var pos = Math.floor(Math.random() * (max - min + 1)) + min;
  moveTo(pos, label + " | rango " + min + "%-" + max + "% | elegido: " + pos + "%");
}

// ── Mueve la cortina a una posición EXACTA ─────────────────────────────────
function moveToExact(pos, label) {
  moveTo(pos, label + " | exacto: " + pos + "%");
}

// ── Configuración de horarios ────────────────────────────────────────────
// Añadir, quitar o editar horarios aquí; el resto del script se adapta solo.
var SCHEDULES = [
  { cron: "0 0 9 * * *",  label: "09:00 Mañana",   type: "random", min: 6,  max: 10 },
  { cron: "0 0 12 * * *", label: "12:00 Mediodía", type: "random", min: 11, max: 40 },
  { cron: "0 0 15 * * *", label: "15:00 Tarde",    type: "random", min: 41, max: 60 },
  { cron: "0 0 18 * * *", label: "18:00 Noche",    type: "random", min: 60, max: 85 },
  { cron: "0 0 21 * * *", label: "21:00 Nocturno", type: "exact",  pos: 85 }
];

// ── Registro de los handlers CRON a partir de la configuración ─────────────
// Se usa una IIFE para capturar correctamente cada "sch" dentro del loop.
for (var i = 0; i < SCHEDULES.length; i++) {
  (function (sch) {
    Shelly.addCronHandler(sch.cron, function () {
      console.log("[" + sch.label + "] Disparador activado");
      if (sch.type === "random") {
        moveToRandom(sch.min, sch.max, sch.label);
      } else {
        moveToExact(sch.pos, sch.label);
      }
    });
  })(SCHEDULES[i]);
}

// ── Confirmación de arranque (lista los horarios cargados dinámicamente) ──
var loadedLabels = [];
for (var j = 0; j < SCHEDULES.length; j++) {
  loadedLabels.push(SCHEDULES[j].label);
}
console.log("Horario de cortina cargado | handlers: " + loadedLabels.join(" / "));
