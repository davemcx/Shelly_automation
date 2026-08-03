// ============================================================
// Shelly Shutter Gen3 | Daily Cover Position Schedule
// Cover component ID : 0
// Cron format        : "sec min hour dom month dow"
// Timezone           : uses the device's configured local time
// ============================================================

// ── Helper: move cover to a RANDOM integer position ─────────
// min/max are inclusive percentage values (0–100)
function moveToRandom(min, max) {
  // Generate a clean whole-integer position within [min, max]
  var pos = Math.floor(Math.random() * (max - min + 1)) + min;

  console.log(
    "Scheduled move | range: " + min + "%-" + max +
    "% | chosen: " + pos + "%"
  );

  // Call the Gen3 Cover API to move to the calculated position
  Shelly.call(
    "Cover.GoTo",
    { id: 0, pos: pos },          // id:0 = first/only cover component
    function (res, err_code, err_msg) {
      if (err_code !== 0) {
        console.log(
          "ERROR Cover.GoTo [" + err_code + "]: " + err_msg
        );
      } else {
        console.log("Cover.GoTo " + pos + "% → accepted");
      }
    }
  );
}

// ── Helper: move cover to an EXACT position ──────────────────
function moveToExact(pos) {
  console.log("Scheduled move | exact: " + pos + "%");

  Shelly.call(
    "Cover.GoTo",
    { id: 0, pos: pos },
    function (res, err_code, err_msg) {
      if (err_code !== 0) {
        console.log(
          "ERROR Cover.GoTo [" + err_code + "]: " + err_msg
        );
      } else {
        console.log("Cover.GoTo " + pos + "% → accepted");
      }
    }
  );
}

// ── 09:00 | Random 6 % – 10 % ───────────────────────────────
// "0 0 9 * * *"  →  every day at 09:00:00
Shelly.addCronHandler("0 0 9 * * *", function () {
  console.log("[09:00] Morning trigger fired");
  moveToRandom(6, 10);
});

// ── 12:00 | Random 11 % – 40 % ──────────────────────────────
// "0 0 12 * * *"  →  every day at 12:00:00
Shelly.addCronHandler("0 0 12 * * *", function () {
  console.log("[12:00] Midday trigger fired");
  moveToRandom(11, 40);
});

// ── 15:00 | Random 41 % – 60 % ──────────────────────────────
// "0 0 15 * * *"  →  every day at 15:00:00
Shelly.addCronHandler("0 0 15 * * *", function () {
  console.log("[15:00] Afternoon trigger fired");
  moveToRandom(41, 60);
});

// ── 18:00 | Random 60 % – 85 % ──────────────────────────────
// "0 0 18 * * *"  →  every day at 18:00:00
Shelly.addCronHandler("0 0 18 * * *", function () {
  console.log("[18:00] Evening trigger fired");
  moveToRandom(60, 85);
});

// ── 21:00 | Exact 85 % ──────────────────────────────────────
// "0 0 21 * * *"  →  every day at 21:00:00
Shelly.addCronHandler("0 0 21 * * *", function () {
  console.log("[21:00] Night trigger fired");
  moveToExact(85);
});

// ── Startup confirmation ─────────────────────────────────────
console.log(
  "Cover schedule loaded | handlers: 09:00 / 12:00 / 15:00 / 18:00 / 21:00"
);
