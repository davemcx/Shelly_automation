// ============================================================
// Shelly Shutter Gen3 | Horario diario de posición de cortina
// Formato CRON : "seg min hora dom mes dow"
// Zona horaria : usa la hora local configurada en el dispositivo
//
// IMPORTANTE: Shelly.addCronHandler NO EXISTE en la API de scripts.
// Los horarios se crean como entradas del componente Schedule del
// dispositivo (Schedule.Create), que llaman a este script mediante
// Script.Eval — igual que hace el script del relé.
// ============================================================

var COVER_ID = 0; // ID del componente Cover (0 = única cortina)

// Poner en false tras la primera ejecución exitosa para evitar duplicados.
// Los horarios persisten en el dispositivo y sobreviven a reinicios.
var CREATE_SCHEDULES = true;


// ── Función base: mueve la cortina y registra el resultado ────────────────
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


// ── Handlers con nombre — cada horario los invoca vía Script.Eval ─────────
function handleMorning() {
  console.log("[09:00 Mañana] Disparador activado");
  moveToRandom(6, 10, "09:00 Mañana");
}

function handleMidday() {
  console.log("[12:00 Mediodía] Disparador activado");
  moveToRandom(11, 40, "12:00 Mediodía");
}

function handleAfternoon() {
  console.log("[15:00 Tarde] Disparador activado");
  moveToRandom(41, 60, "15:00 Tarde");
}

function handleEvening() {
  console.log("[18:00 Noche] Disparador activado");
  moveToRandom(60, 85, "18:00 Noche");
}

function handleNight() {
  console.log("[21:00 Nocturno] Disparador activado");
  moveToExact(85, "21:00 Nocturno");
}


// ── Configuración de horarios: CRON → función a invocar ────────────────────
var SCHEDULES = [
  { cron: "0 0 9 * * *",  label: "09:00 Mañana",   code: "handleMorning();" },
  { cron: "0 0 12 * * *", label: "12:00 Mediodía", code: "handleMidday();" },
  { cron: "0 0 15 * * *", label: "15:00 Tarde",    code: "handleAfternoon();" },
  { cron: "0 0 18 * * *", label: "18:00 Noche",    code: "handleEvening();" },
  { cron: "0 0 21 * * *", label: "21:00 Nocturno", code: "handleNight();" }
];


// ── Creación de horarios en el dispositivo (Schedule.Create) ───────────────

/**
 * scheduleExists(jobs, cron)
 * Evita crear horarios duplicados al reiniciar el script.
 */
function scheduleExists(jobs, cron) {
  for (var i = 0; i < jobs.length; i++) {
    if (jobs[i].timespec === cron) {
      return true;
    }
  }
  return false;
}

/**
 * createSchedule(sch, scriptId)
 * Crea un horario persistente que llama a la función correspondiente
 * de este script vía Script.Eval.
 */
function createSchedule(sch, scriptId) {
  Shelly.call(
    "Schedule.Create",
    {
      enable   : true,
      timespec : sch.cron,
      calls    : [
        {
          method : "Script.Eval",
          params : { id: scriptId, code: sch.code }
        }
      ]
    },
    function (result, error_code, error_message) {
      if (error_code === 0) {
        console.log("Horario creado → " + sch.label + " [ID: " + result.id + "]");
      } else {
        console.log("ERROR al crear horario '" + sch.label + "' →", error_code, error_message);
      }
    }
  );
}

/**
 * initSchedules()
 * Lista los horarios existentes y crea los que falten.
 */
function initSchedules() {
  var scriptId = Shelly.getCurrentScriptId();

  Shelly.call(
    "Schedule.List",
    {},
    function (result, error_code, error_message) {

      if (error_code !== 0) {
        console.log("ERROR al listar horarios →", error_code, error_message);
        return;
      }

      var jobs = result.jobs || [];

      for (var i = 0; i < SCHEDULES.length; i++) {
        var sch = SCHEDULES[i];
        if (!scheduleExists(jobs, sch.cron)) {
          createSchedule(sch, scriptId);
        } else {
          console.log("El horario ya existe → " + sch.label);
        }
      }

    }
  );
}


// ── Punto de entrada ─────────────────────────────────────────────────────────
console.log("Script cargado. Horario de cortina listo.");

if (CREATE_SCHEDULES) {
  initSchedules();
} else {
  console.log("Creación automática de horarios desactivada (CREATE_SCHEDULES = false).");
}
