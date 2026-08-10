// ================================================================
//  SIMULADOR DE PRESENCIA EN EL HOGAR  —  Shelly mJS (Gen3)
//  Imita ocupación encendiendo luces por turnos en dos franjas diarias.
// ================================================================

// ----------------------------------------------------------------
// VARIABLES CONFIGURABLES  (edita esto según tu instalación)
// ----------------------------------------------------------------

// Lista de luces a controlar. AQUÍ es donde se especifica cada dispositivo Shelly.
// Cada entrada es UN canal de switch, que puede estar:
//   - en ESTE mismo dispositivo (donde corre el script)   → ip: ""
//   - en OTRO Shelly de la red local (relé independiente) → ip: "192.168.x.x"
//
//   ip   -> IP local del Shelly que tiene esa luz ("" = este mismo dispositivo)
//   id   -> ID de canal de switch dentro de ESE dispositivo (0, 1, 2...)
//   auth -> opcional; solo si ese Shelly tiene usuario/contraseña local activados,
//           formato "usuario:contraseña" (se añade a la URL para autenticación)
//
// Para saber la IP de cada Shelly: app Shelly → dispositivo → Ajustes → Red Wi-Fi,
// o revisa la tabla de clientes de tu router.
var LIGHTS = [
  { ip: "",             id: 0 },   // Luz1: canal 0 de ESTE dispositivo (local)
  { ip: "192.168.1.63", id: 0 },   // Luz2: canal 0 del Shelly en 192.168.1.63 (Light R)
  { ip: "",             id: 1 }    // Luz3: canal 1 de ESTE dispositivo (local)
];

// Duraciones permitidas de encendido (minutos). Se elige una al azar en cada ciclo.
var DURATIONS_MIN = [7, 9, 11, 13, 15, 17, 19];

// Franjas horarias activas  [horaInicio, minInicio, horaFin, minFin]
// Las horas se evalúan contra la zona horaria local configurada en el dispositivo.
var WINDOWS = [
  [5,  30,  7,  0],   // Mañana  05:30 – 07:00
  [21, 30, 23,  0]    // Noche   21:30 – 23:00
];

// Cada cuánto (ms) volver a comprobar el horario mientras estamos fuera de una franja.
// 60 s es un buen equilibrio entre respuesta rápida y bajo consumo de CPU.
var IDLE_CHECK_MS = 60 * 1000;   // 60 000 ms = 1 minuto

// ----------------------------------------------------------------
// ESTADO EN TIEMPO DE EJECUCIÓN  (no editar)
// ----------------------------------------------------------------
var currentIdx = 0;      // Qué luz sigue en la secuencia (0-2)
var activeTimer = null;  // Handle del Timer pendiente actual
var lightsAreOff = true; // Evita reenviar Switch.Set si ya está todo apagado

// ----------------------------------------------------------------
// FUNCIONES AUXILIARES
// ----------------------------------------------------------------

// Convierte la hora local del sistema Shelly "HH:MM" → minutos desde medianoche.
// Ejemplo: "21:45" → 1305
function timeStrToMin(t) {
  var h = 0;
  var m = 0;
  var colon = 0;

  // Busca la posición del ":" manualmente (String.indexOf no existe en todos los builds de mJS)
  for (var i = 0; i < t.length; i++) {
    if (t[i] === ":") { colon = i; break; }
  }

  h = 1 * t.slice(0, colon);
  m = 1 * t.slice(colon + 1);
  return h * 60 + m;
}

// Devuelve el índice de la franja que contiene 'nowMin', o -1 si no hay ninguna.
function findActiveWindow(nowMin) {
  for (var i = 0; i < WINDOWS.length; i++) {
    var ws = WINDOWS[i][0] * 60 + WINDOWS[i][1]; // inicio de franja
    var we = WINDOWS[i][2] * 60 + WINDOWS[i][3]; // fin de franja
    if (nowMin >= ws && nowMin < we) return i;
  }
  return -1;
}

// Devuelve una duración aleatoria de DURATIONS_MIN, convertida a milisegundos.
function randomDurMs() {
  var pick = DURATIONS_MIN[Math.floor(Math.random() * DURATIONS_MIN.length)];
  print("PresenceSim ▶ duración elegida:", pick, "min");
  return pick * 60 * 1000;
}

// Cancela de forma segura cualquier timer pendiente, para que nunca haya dos activos a la vez.
function clearActiveTimer() {
  if (activeTimer !== null) {
    Timer.clear(activeTimer);
    activeTimer = null;
  }
}

// Callback genérico para Shelly.call: solo registra un error si la llamada falla.
// MEJORA: antes las llamadas a Switch.Set eran "silenciosas"; ahora un fallo
// (p. ej. un canal desconectado) queda registrado en el log del dispositivo.
function onSwitchResult(result, error_code, error_message) {
  if (error_code !== 0) {
    print("PresenceSim ▶ ERROR Switch.Set:", error_message);
  }
}

// Envía Switch.Set al dispositivo correcto de LIGHTS[i]:
//  - ip === ""  → llamada RPC local directa (Shelly.call), sin pasar por la red.
//  - ip !== ""  → llamada RPC remota vía HTTP.GET a "http://<ip>/rpc/Switch.Set?..."
// Esta es la pieza clave para controlar VARIOS Shellys físicos desde un solo script.
function setSwitch(light, on, cb) {
  if (!light.ip || light.ip === "") {
    Shelly.call("Switch.Set", { id: light.id, on: on }, cb, null);
  } else {
    var url = "http://" + light.ip + "/rpc/Switch.Set?id=" + light.id +
              "&on=" + (on ? "true" : "false");
    // Si el Shelly remoto tiene login local, se puede incrustar user:pass en la URL
    // (Shelly soporta auth básica/digest embebida en la URL, según su documentación).
    if (light.auth) {
      url = "http://" + light.auth + "@" + light.ip + "/rpc/Switch.Set?id=" +
            light.id + "&on=" + (on ? "true" : "false");
    }
    Shelly.call("HTTP.GET", { url: url, timeout: 5 }, cb, null);
  }
}

// Apaga todas las salidas controladas (en todos los dispositivos de LIGHTS).
function allOff() {
  for (var i = 0; i < LIGHTS.length; i++) {
    setSwitch(LIGHTS[i], false, onSwitchResult);
  }
  lightsAreOff = true;
  print("PresenceSim ▶ todas las luces APAGADAS");
}

// Enciende SOLO el índice indicado; apaga todos los demás.
// Garantiza estado exclusivo: nunca hay dos luces encendidas a la vez,
// sin importar en cuántos dispositivos físicos estén repartidas.
function lightOn(idx) {
  for (var i = 0; i < LIGHTS.length; i++) {
    setSwitch(LIGHTS[i], (i === idx), onSwitchResult);
  }
  lightsAreOff = false;
  var l = LIGHTS[idx];
  print("PresenceSim ▶ Luz", idx + 1, "(", (l.ip === "" ? "local" : l.ip),
        "canal", l.id, ") ENCENDIDA");
}

// ----------------------------------------------------------------
// TICK PRINCIPAL — se ejecuta cada vez que expira el timer
// ----------------------------------------------------------------
function tick() {
  activeTimer = null; // el timer ya se disparó; limpiamos el handle

  // Lee la hora local actual del dispositivo (requiere NTP / zona horaria configurada).
  var sys = Shelly.getComponentStatus("sys");

  // Seguro: si la hora aún no está sincronizada, espera y reintenta.
  if (!sys || !sys.time || sys.time === "") {
    print("PresenceSim ▶ hora no sincronizada, reintentando en 30 s …");
    activeTimer = Timer.set(30 * 1000, false, tick);
    return;
  }

  var nowMin = timeStrToMin(sys.time);
  var winIdx = findActiveWindow(nowMin);

  if (winIdx !== -1) {
    // ── DENTRO DE UNA FRANJA ACTIVA ────────────────────────────
    // Enciende la luz actual (exclusiva) y avanza el índice.
    lightOn(currentIdx);
    currentIdx = (currentIdx + 1) % LIGHTS.length; // 0→1→2→0

    // Calcula la duración aleatoria, pero sin sobrepasar el fin de la franja.
    // MEJORA: antes una luz podía quedar encendida varios minutos después de
    // cerrarse la franja, si el timer expiraba más tarde. Ahora se recorta.
    var dur = randomDurMs();
    var we = WINDOWS[winIdx][2] * 60 + WINDOWS[winIdx][3];
    var remainMs = (we - nowMin) * 60 * 1000;
    if (dur > remainMs) {
      dur = remainMs;
      print("PresenceSim ▶ duración recortada al cierre de franja");
    }

    activeTimer = Timer.set(dur, false, tick);

  } else {
    // ── FUERA DE FRANJA ────────────────────────────────────────
    // MEJORA: solo se envía el comando de apagado la primera vez que se
    // detecta que estamos fuera de franja, no en cada comprobación de 1 min.
    // Esto reduce el desgaste de los relés y el tráfico en la red local.
    if (!lightsAreOff) {
      allOff();
    }
    print("PresenceSim ▶ fuera de franja. Próxima comprobación en",
          IDLE_CHECK_MS / 60000, "min  |  hora:", sys.time);
    activeTimer = Timer.set(IDLE_CHECK_MS, false, tick);
  }
}

// ----------------------------------------------------------------
// PUNTO DE ENTRADA
// ----------------------------------------------------------------
print("PresenceSim ▶ script cargado — iniciando planificador …");
clearActiveTimer(); // Seguro: cancela cualquier timer residual de una ejecución anterior
allOff();            // Empieza desde un estado limpio conocido
tick();               // Lanza la primera evaluación inmediatamente
