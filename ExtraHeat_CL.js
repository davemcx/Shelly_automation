// ─── Configuración ──────────────────────────────────────────────────────────
var THERMOSTAT_IP   = "192.168.1.22"; // IP del SBTR-001AEU
var VALVE_ON_MIN    = 5;              // Relé en ON si la válvula >= este valor (%)
var VALVE_ON_MAX    = 100;            // Relé en ON si la válvula <= este valor (%)
var POLL_INTERVAL_S = 30;             // Frecuencia de consulta al termostato (segundos)
var MAX_FAILS       = 5;              // Avisos tras N fallos consecutivos de conexión
// ──────────────────────────────────────────────────────────────────────────

var consecutiveFails = 0;

function checkValveAndControl() {
  Shelly.call(
    "HTTP.GET",
    {
      url: "http://" + THERMOSTAT_IP + "/thermostat/0",
      timeout: 5
    },
    function (result, error_code, error_msg) {
      if (error_code !== 0 || result === null || typeof result.body !== "string") {
        consecutiveFails++;
        print("Fallo al consultar el termostato — código", error_code, ":", error_msg);
        if (consecutiveFails === MAX_FAILS) {
          print("Aviso: ", MAX_FAILS, "fallos consecutivos consultando el termostato.");
        }
        return;
      }

      var data;
      try {
        data = JSON.parse(result.body);
      } catch (e) {
        print("No se pudo parsear la respuesta del termostato:", result.body);
        return;
      }

      var valvePos = data.pos; // 0–100 (%)
      if (typeof valvePos !== "number") {
        print("Respuesta inesperada — falta el campo 'pos':", result.body);
        return;
      }

      consecutiveFails = 0; // se restablece tras una lectura correcta
      print("Posición de la válvula:", valvePos, "%");

      var shouldBeOn = (valvePos >= VALVE_ON_MIN && valvePos <= VALVE_ON_MAX);

      // Lectura local del estado del relé (sin llamada HTTP interna),
      // más rápida y eficiente que Shelly.call("Switch.GetStatus", ...)
      var status = Shelly.getComponentStatus("switch:0");
      if (status === null) {
        print("No se pudo leer el estado del relé, se omite esta iteración.");
        return;
      }

      var isOn = status.output;

      if (shouldBeOn && !isOn) {
        print("→ Encendiendo relé (válvula al", valvePos, "%)");
        Shelly.call("Switch.Set", { id: 0, on: true });
      } else if (!shouldBeOn && isOn) {
        print("→ Apagando relé (válvula al", valvePos, "%)");
        Shelly.call("Switch.Set", { id: 0, on: false });
      } else {
        print("→ Sin cambios (el relé ya está", (isOn ? "ENCENDIDO" : "APAGADO") + ")");
      }
    }
  );
}

// Si el script se reinicia, evita timers duplicados acumulados
Timer.clear();

// Ejecuta una vez al iniciar el script
checkValveAndControl();

// Repite cada POLL_INTERVAL_S segundos
Timer.set(POLL_INTERVAL_S * 1000, true, checkValveAndControl);
