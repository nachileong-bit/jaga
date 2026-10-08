// web/app.js - Jaga web demo. Vanilla JS, no framework, no build step.

const API = "/api";
let sessionId = null;
let currentDay = 0;
let scenarioMode = "supported";
let isMeiLing = false;

// ---- DOM elements ----

const chatBody = document.getElementById("chat-body");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const clockContent = document.getElementById("clock-content");
const daySlider = document.getElementById("day-slider");
const dayValue = document.getElementById("day-value");
const scenarioSelect = document.getElementById("scenario-select");
const resetBtn = document.getElementById("reset-btn");
const nextCheckinBtn = document.getElementById("next-checkin-btn");
const meiLingToggle = document.getElementById("mei-ling-toggle");
const contactName = document.getElementById("contact-name");

// ---- API calls ----

async function apiCall(endpoint, method, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}/${endpoint}`, opts);
  if (!res.ok) {
    console.error("API error:", await res.text());
    return null;
  }
  return res.json();
}

async function reset(scenario) {
  const data = await apiCall("demo/reset", "POST", {
    scenario: scenario || scenarioSelect.value,
    sessionId,
  });
  if (!data) return;
  sessionId = data.sessionId;
  renderState(data.state);
}

async function sendMessage(text, button, reporter) {
  if (!sessionId) {
    await reset(scenarioSelect.value);
  }
  const data = await apiCall("demo/message", "POST", {
    sessionId,
    text,
    button,
    reporter: reporter || (isMeiLing ? "support_person" : "user"),
  });
  if (!data) return;
  renderState(data.state);
}

async function advance(toDay) {
  if (!sessionId) return;
  const data = await apiCall("demo/advance", "POST", {
    sessionId,
    toDay,
  });
  if (!data) return;
  renderState(data.state);
}

// ---- Rendering ----

function renderState(state) {
  if (!state) return;
  currentDay = state.day;
  scenarioMode = state.mode;
  dayValue.textContent = state.day;
  daySlider.value = state.day;

  // Enable/disable Mei Ling toggle
  meiLingToggle.disabled = state.mode !== "supported";

  // Update contact name
  contactName.textContent = "Jaga";

  renderTranscript(state.transcript);
  renderClockPanel(state.clockPanel);
}

function renderTranscript(transcript) {
  chatBody.innerHTML = "";
  let lastDay = -1;

  for (const entry of transcript) {
    // Day separator
    if (entry.day !== lastDay) {
      const daySep = document.createElement("div");
      daySep.className = "msg-day";
      daySep.textContent = `Day ${entry.day}`;
      chatBody.appendChild(daySep);
      lastDay = entry.day;
    }

    const msg = document.createElement("div");
    msg.className = `msg msg-${entry.role}`;

    // Text
    const text = document.createElement("div");
    text.textContent = entry.text;
    msg.appendChild(text);

    // Source link
    if (entry.sourceLabel && entry.sourceUrl) {
      const source = document.createElement("div");
      source.className = "msg-source";
      const link = document.createElement("a");
      link.href = entry.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = entry.sourceLabel;
      source.appendChild(link);
      msg.appendChild(source);
    }

    // Clinic card. Everything on it is prototype data and is labelled as such.
    if (entry.card) {
      const c = entry.card;
      const card = document.createElement("div");
      card.className = "msg-card";
      const lab = document.createElement("div");
      lab.className = "msg-prototype";
      lab.textContent = c.label;
      card.appendChild(lab);
      for (const [cls, line] of [
        ["card-clinic", c.clinic],
        ["card-line", c.distance],
        ["card-slot", "Next appointment: " + c.slot],
        ["card-line", c.consult],
        ["card-line", c.outOfPocket],
      ]) {
        const row = document.createElement("div");
        row.className = cls;
        row.textContent = line;
        card.appendChild(row);
      }
      msg.appendChild(card);
    }

    // Link (GP summary)
    if (entry.link) {
      const a = document.createElement("a");
      a.className = "msg-link";
      a.href = `${entry.link.href}?sessionId=${encodeURIComponent(sessionId)}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = entry.link.label;
      msg.appendChild(a);
    }

    // Buttons
    if (entry.buttons && entry.buttons.length > 0) {
      const btnContainer = document.createElement("div");
      btnContainer.className = "msg-buttons";
      for (const btnLabel of entry.buttons) {
        const btn = document.createElement("button");
        btn.className = "msg-btn";
        btn.textContent = btnLabel;
        btn.onclick = () => sendMessage(null, btnLabel);
        btnContainer.appendChild(btn);
      }
      msg.appendChild(btnContainer);
    }

    chatBody.appendChild(msg);
  }

  // Scroll to bottom
  chatBody.scrollTop = chatBody.scrollHeight;
}

function renderClockPanel(panel) {
  if (!panel) {
    clockContent.innerHTML = '<p class="placeholder">Start a scenario to see the clock.</p>';
    return;
  }

  const rows = [];

  rows.push(clockRow("Mode", panel.mode));
  rows.push(clockRow("Symptom", panel.symptom ?? "-", !panel.symptom));
  rows.push(clockRow("Onset (raw)", panel.onsetRawText ?? "-", !panel.onsetRawText));
  rows.push(clockRow("Min duration (days)", String(panel.minDurationDays)));
  rows.push(clockRow("Confidence", panel.confidence ?? "-", !panel.confidence));
  rows.push(clockRow("Trajectory", panel.trajectory ?? "-", !panel.trajectory));
  rows.push(clockRow("State", panel.state ?? "-", !panel.state));
  rows.push(clockRow("Discordance", panel.discordance ? "Yes" : "No"));
  rows.push(clockRow("Missed check-ins", String(panel.missedCheckins)));
  rows.push(clockRow("Policy", `${panel.policyId ?? "-"} v${panel.policyVersion ?? "-"}`));
  rows.push(clockRow("Last rule fired", panel.lastRuleFired ?? "-", !panel.lastRuleFired));

  // Red flags
  if (panel.redFlags && panel.redFlags.length > 0) {
    const rfHtml = panel.redFlags
      .map((rf) => {
        let detail = "";
        if (rf.status === "reported" && rf.reportedBy) {
          detail = `reported by ${rf.reporter === "support_person" ? "support person" : "user"}${rf.reportedAt ? ` on day ${dayOf(rf.reportedAt)}` : ""}`;
        } else if (rf.status === "denied") {
          detail = "denied";
        } else {
          detail = "unknown";
        }
        return `<div class="redflag-row">
          <span class="redflag-status ${rf.status}">${rf.key}: ${detail}</span>
        </div>`;
      })
      .join("");
    rows.push(clockRowHtml("Red flags", rfHtml));
  }

  // Self-treatment
  if (panel.selfTreatment && panel.selfTreatment.length > 0) {
    const stHtml = panel.selfTreatment
      .map((st) => `<div class="redflag-row">${st.label}: ${st.confirmed ? "confirmed" : "unconfirmed"}</div>`)
      .join("");
    rows.push(clockRowHtml("Self-treatment", stHtml));
  } else {
    rows.push(clockRow("Self-treatment", "-", true));
  }

  clockContent.innerHTML = rows.join("");
}

function clockRow(label, value, isUnknown) {
  const valClass = isUnknown ? "clock-value unknown" : "clock-value";
  return `<div class="clock-row">
    <span class="clock-label">${label}</span>
    <span class="${valClass}">${value}</span>
  </div>`;
}

function clockRowHtml(label, html) {
  return `<div class="clock-row">
    <span class="clock-label">${label}</span>
    <span class="clock-value">${html}</span>
  </div>`;
}

function dayOf(iso) {
  if (!iso) return "?";
  const start = new Date("2026-01-01T08:00:00.000Z").getTime();
  const t = new Date(iso).getTime();
  return Math.floor((t - start) / 86400000);
}

// ---- Event handlers ----

sendBtn.addEventListener("click", () => {
  const text = chatInput.value.trim();
  if (!text) return;
  sendMessage(text, null);
  chatInput.value = "";
});

chatInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    sendBtn.click();
  }
});

daySlider.addEventListener("input", (e) => {
  dayValue.textContent = e.target.value;
});

daySlider.addEventListener("change", (e) => {
  const newDay = parseInt(e.target.value, 10);
  if (newDay > currentDay) {
    advance(newDay);
  } else {
    // Can't go backwards - reset the slider
    daySlider.value = currentDay;
    dayValue.textContent = currentDay;
  }
});

resetBtn.addEventListener("click", () => {
  reset(scenarioSelect.value);
});

scenarioSelect.addEventListener("change", () => {
  reset(scenarioSelect.value);
});

nextCheckinBtn.addEventListener("click", () => {
  // Advance to the next check-in day (7 days from current for cough)
  const next = Math.ceil((currentDay + 1) / 7) * 7;
  if (next <= 60) {
    advance(next);
  }
});

meiLingToggle.addEventListener("change", (e) => {
  isMeiLing = e.target.checked;
  chatInput.placeholder = isMeiLing ? "Type as Mei Ling..." : "Type a message...";
});

// Quick buttons
document.querySelectorAll(".quick-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const button = btn.getAttribute("data-button");
    sendMessage(null, button);
  });
});

// ---- Initialize ----

reset("mr_tan");
