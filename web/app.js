// web/app.js - Jaga web demo. Vanilla JS, no framework, no build step.

const API = "/api";
let sessionId = null;
let lastState = null; // newest state from the server, used by the tour
let currentDay = 0;
let scenarioMode = "supported";
let isMeiLing = false;

// Scope card state: full on every reload, collapses after first interaction.
let scopeCardCollapsed = false;

// ---- DOM elements ----

const chatBody = document.getElementById("chat-body");
const chatInput = document.getElementById("chat-input");
const sendBtn = document.getElementById("send-btn");
const clockContent = document.getElementById("clock-content");
const clockSimDateRow = document.getElementById("clock-simdate-row");
const clockSimDate = document.getElementById("clock-simdate");
const daySlider = document.getElementById("day-slider");
const dayValue = document.getElementById("day-value");
const scenarioSelect = document.getElementById("scenario-select");
const resetBtn = document.getElementById("reset-btn");
const nextCheckinBtn = document.getElementById("next-checkin-btn");
const meiLingToggle = document.getElementById("mei-ling-toggle");
const contactName = document.getElementById("contact-name");
const contactStatus = document.getElementById("contact-status");
const quickButtons = document.getElementById("quick-buttons");
const tourButtons = document.getElementById("tour-buttons");
const clockToggleBtn = document.getElementById("clock-toggle-btn");

// ---- API calls ----

async function apiCall(endpoint, method, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}/${endpoint}`, opts);
  if (res.status === 404 && endpoint !== "demo/reset") {
    // The server restarted (for example after an update) and forgot this chat.
    // Start a fresh one instead of leaving the buttons dead.
    sessionId = null;
    await reset(scenarioSelect.value);
    showNotice("The demo server restarted, so the chat started again.");
    return null;
  }
  if (!res.ok) {
    console.error("API error:", await res.text());
    return null;
  }
  return res.json();
}

function showNotice(text) {
  const n = document.createElement("div");
  n.className = "demo-notice";
  n.textContent = text;
  document.body.appendChild(n);
  setTimeout(() => n.remove(), 6000);
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
  collapseScopeCard();
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

// ---- Scope card ----

function buildScopeCardElement() {
  const card = document.createElement("div");
  card.className = "scope-card";
  card.innerHTML = `
    <div class="scope-card-title">Try Jaga (hackathon prototype)</div>
    <div class="scope-card-body">
      <p>Covered now: a cough that won't go away.</p>
      <p>Coming next, after a doctor checks the rules: fever, mouth ulcer.</p>
      <p>Anything else, Jaga will say it can't help yet. It won't guess.</p>
      <p class="scope-card-emergency">Jaga is not a doctor and never diagnoses. Emergency? Call 995.</p>
    </div>
    <div class="scope-card-actions">
      <button class="scope-card-tour-btn">Start the 1-minute tour</button>
      <button class="scope-card-close-btn">x</button>
    </div>
  `;
  card.querySelector(".scope-card-tour-btn").onclick = () => {
    collapseScopeCard();
    runTourStep(1);
  };
  card.querySelector(".scope-card-close-btn").onclick = () => {
    collapseScopeCard();
  };
  return card;
}

function buildScopeCardPill() {
  const pill = document.createElement("div");
  pill.className = "scope-card-pill";
  pill.innerHTML = `<span>Covered: cough only</span> <button class="scope-pill-tour">Tour</button>`;
  pill.querySelector(".scope-pill-tour").onclick = () => {
    scopeCardCollapsed = false;
    renderTranscript(lastTranscript);
  };
  return pill;
}

let lastTranscript = [];

function collapseScopeCard() {
  if (!scopeCardCollapsed) {
    scopeCardCollapsed = true;
    renderTranscript(lastTranscript);
  }
}

// ---- Rendering ----

function renderState(state) {
  lastState = state;
  if (!state) return;
  currentDay = state.day;
  scenarioMode = state.mode;
  dayValue.textContent = state.day;
  daySlider.value = state.day;

  // Enable/disable Mei Ling toggle
  meiLingToggle.disabled = state.mode !== "supported";

  // Update contact name
  contactName.textContent = "Jaga";

  // Update simDate in clock panel
  if (state.simDate) {
    const d = new Date(state.simDate);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const formatted = `${days[d.getUTCDay()]} ${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    clockSimDate.textContent = formatted;
    clockSimDateRow.style.display = "flex";
  }

  // Enable tour step 4 after clock started
  const clockStarted = state.clockPanel && state.clockPanel.symptom;
  document.querySelectorAll('[data-tour="4"]').forEach((b) => { b.disabled = !clockStarted || tourRunning; });

  renderTranscript(state.transcript);
  renderClockPanel(state.clockPanel);
}

function renderTranscript(transcript) {
  lastTranscript = transcript;
  chatBody.innerHTML = "";

  // Scope card or pill at the very top
  if (scopeCardCollapsed) {
    chatBody.appendChild(buildScopeCardPill());
  } else {
    chatBody.appendChild(buildScopeCardElement());
  }

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

    // Sticker: render as image, no bubble background
    if (entry.sticker) {
      msg.className = "msg msg-sticker";
      const img = document.createElement("img");
      img.src = `/web/stickers/${entry.sticker}`;
      img.alt = "";
      img.className = "sticker-img";
      img.onerror = () => { msg.remove(); };
      msg.appendChild(img);
      chatBody.appendChild(msg);
      continue;
    }

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

  // Render suggested-reply chips or normal quick buttons
  renderQuickArea(transcript);

  // Scroll to bottom
  // Until the person says something, keep the scope card at the top in view.
  chatBody.scrollTop = transcript.some((t) => t.role !== "jaga") ? chatBody.scrollHeight : 0;
}

// ---- Suggested-reply chips ----

const ASK_SYMPTOM_TEXT = "Tell me about your cough, in your own words. For example: \"cough 3 weeks, got phlegm\". Other symptoms aren't covered yet.";

function renderQuickArea(transcript) {
  const jagaMsgs = transcript.filter((t) => t.role === "jaga" && !t.sticker);
  const lastJaga = jagaMsgs[jagaMsgs.length - 1];
  const isAskSymptom = lastJaga && lastJaga.text === ASK_SYMPTOM_TEXT;

  quickButtons.innerHTML = "";

  if (isAskSymptom) {
    const chips = [
      { text: "Cough 3 weeks already, got phlegm", tag: null },
      { text: "Cough on and off since last month", tag: null },
      { text: "I have a fever", tag: "not covered" },
      { text: "Cut my finger", tag: "not covered" },
    ];
    for (const chip of chips) {
      const btn = document.createElement("button");
      btn.className = "chip-btn" + (chip.tag ? " chip-not-covered" : "");
      btn.textContent = chip.text;
      if (chip.tag) {
        const tag = document.createElement("span");
        tag.className = "chip-tag";
        tag.textContent = chip.tag;
        btn.appendChild(tag);
      }
      btn.onclick = () => sendMessage(chip.text, null);
      quickButtons.appendChild(btn);
    }
  } else {
    const b1 = document.createElement("button");
    b1.className = "quick-btn";
    b1.textContent = "Took medicine";
    b1.onclick = () => sendMessage(null, "Took medicine");
    quickButtons.appendChild(b1);

    const b2 = document.createElement("button");
    b2.className = "quick-btn";
    b2.textContent = "Noticed blood";
    b2.onclick = () => sendMessage(null, "Noticed blood");
    quickButtons.appendChild(b2);
  }
}

function renderClockPanel(panel) {
  if (!panel) {
    clockContent.innerHTML = '<p class="placeholder">Start a scenario to see the clock.</p>';
    return;
  }

  const rows = [];

  // Keep the simDate row at the top (it is a separate element outside clockContent)
  // The rest of the rows go into clockContent.

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

// ---- Judge tour ----

const tourSteps = {
  1: { hint: "" },
  2: { hint: "The cough started a week before day 0, so demo day 7 = cough day 14." },
  3: { hint: "" },
  4: { hint: "" },
  5: { hint: "" },
  6: { hint: "Then tap Yes to the next question to see the 995 reply." },
};

let tourRunning = false;
function setTourButtonsEnabled(enabled) {
  tourRunning = !enabled;
  const st = lastState;
  const clockStarted = !!(st && st.clockPanel && st.clockPanel.symptom);
  document.querySelectorAll(".tour-btn, .tour-pill").forEach((btn) => {
    const step = parseInt(btn.getAttribute("data-tour"), 10);
    // Step 4 (ask a question) only makes sense once the clock has started.
    btn.disabled = !enabled || (step === 4 && !clockStarted);
  });
}

function showTourTyping() {
  contactStatus.textContent = "typing...";
}

function restoreContactStatus() {
  contactStatus.textContent = "online";
}

function tickTourStep(step) {
  const btn = tourButtons.querySelector(`[data-tour="${step}"]`);
  if (btn) {
    btn.classList.add("tour-done");
    btn.textContent = btn.textContent + " ✓";
  }
  const pill = document.querySelector(`.tour-pill[data-tour="${step}"]`);
  if (pill) {
    pill.classList.add("tour-done");
  }
}

async function runSteps(steps) {
  for (const s of steps) {
    await s();
  }
}

function scrollChatIntoView() {
  const phoneFrame = document.querySelector(".phone-frame");
  if (phoneFrame) {
    phoneFrame.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  chatBody.scrollTop = chatBody.scrollHeight;
}

function showTourHint(step, text) {
  const el = document.getElementById(`tour-hint-${step}`);
  if (el && text) {
    el.textContent = text;
    el.style.display = "block";
  }
}

async function runTourStep(step) {
  setTourButtonsEnabled(false);
  showTourTyping();

  try {
    if (step === 1) {
      await runSteps([
        () => { scenarioSelect.value = "mr_tan"; return reset("mr_tan"); },
        () => sendMessage(null, "Add a trusted person"),
      ]);
    } else if (step === 2) {
      // Intake only if the clock has not started yet, then one check-in reaches day 14 of the cough.
      const st = getSessionState();
      const started = st && st.clockPanel && st.clockPanel.symptom;
      const steps = started ? [] : [
        () => sendMessage("cough", null),
        () => sendMessage(null, "About a week ago"),
        () => sendMessage(null, "No"),
        () => sendMessage(null, "No"),
      ];
      steps.push(
        () => sendMessage(null, "Took medicine"),
        () => sendMessage(null, "Correct"),
        () => advance((st && st.day ? st.day : 0) + 7),
        () => sendMessage(null, "Still got"),
      );
      await runSteps(steps);
    } else if (step === 3) {
      await runSteps([
        () => sendMessage(null, "Book appointment"),
      ]);
      // Open newest GP summary link in a new tab
      setTimeout(() => {
        const link = document.querySelector('.msg-link[href*="summary.html"]');
        if (link) {
          window.open(link.href, "_blank");
        }
      }, 500);
    } else if (step === 4) {
      await runSteps([
        () => sendMessage("Which cough medicine should I take?", null),
      ]);
    } else if (step === 5) {
      await runSteps([
        () => { scenarioSelect.value = "mr_tan"; return reset("mr_tan"); },
        () => sendMessage(null, "Add a trusted person"),
        () => sendMessage("I have a fever", null),
      ]);
    } else if (step === 6) {
      await runSteps([
        () => { scenarioSelect.value = "ms_lim"; return reset("ms_lim"); },
        () => sendMessage(null, "On my own"),
        () => sendMessage("cough", null),
        () => sendMessage(null, "A few days ago"),
        () => sendMessage(null, "Yes"),
      ]);
    }
    tickTourStep(step);
  } catch (e) {
    console.error("Tour step error:", e);
  }

  restoreContactStatus();

  // Re-enable tour buttons: step 4 depends on clock started
  setTourButtonsEnabled(true);

  // Show hints for steps 2 and 6
  const hintMap = { 2: tourSteps[2].hint, 6: tourSteps[6].hint };
  if (hintMap[step]) showTourHint(step, hintMap[step]);

  scrollChatIntoView();
}

// Fetch current session state for re-enabling buttons
function getSessionState() {
  return lastState;
}

// Tour button event handlers
document.querySelectorAll(".tour-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const step = parseInt(btn.getAttribute("data-tour"), 10);
    collapseScopeCard();
    runTourStep(step);
  });
});

document.querySelectorAll(".tour-pill").forEach((btn) => {
  btn.addEventListener("click", () => {
    const step = parseInt(btn.getAttribute("data-tour"), 10);
    collapseScopeCard();
    runTourStep(step);
  });
});

// Clock toggle (mobile)
clockToggleBtn.addEventListener("click", () => {
  const content = document.getElementById("clock-content");
  const isHidden = content.style.display === "none";
  if (isHidden) {
    content.style.display = "";
    clockToggleBtn.textContent = "Hide Jaga Clock";
  } else {
    content.style.display = "none";
    clockToggleBtn.textContent = "Show Jaga Clock";
  }
});

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

// ---- Initialize ----

reset("mr_tan");
