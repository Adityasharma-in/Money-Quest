// Money Quest — Supabase-backed tracker (localStorage fallback offline)
const $ = (id) => document.getElementById(id);

const SB = window.MONEY_QUEST_SUPABASE || {};
const supabaseClient = (window.supabase && SB.url && SB.anonKey)
  ? window.supabase.createClient(SB.url, SB.anonKey)
  : null;

let cloudOK = false;
let state = { goal: null, entries: [], currency: "₹" };

function setCloudStatus(mode, msg) {
  const el = $("cloudStatus");
  if (!el) return;
  el.dataset.mode = mode;
  el.textContent = msg;
  el.title = msg;
}

function cacheLocal() {
  try { localStorage.setItem("moneyQuest-v1", JSON.stringify(state)); } catch {}
}
function loadLocal() {
  try { return JSON.parse(localStorage.getItem("moneyQuest-v1")) || null; }
  catch { return null; }
}

function fmt(n) {
  return Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function money(n) { return `${state.currency}${fmt(n)}`; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function parseDate(s) {
  const d = new Date(s + "T00:00:00");
  return isNaN(d) ? null : d;
}
function prettyDate(d) {
  if (!d) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function getSaved() {
  return state.entries.reduce((s, e) => s + Number(e.amount || 0), 0);
}
function getEndDate() {
  if (!state.goal) return null;
  const d = parseDate(state.goal.start);
  if (!d) return null;
  d.setDate(d.getDate() + Number(state.goal.days));
  return d;
}
function getDaysLeft() {
  const end = getEndDate();
  if (!end) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.ceil((end - now) / 86400000);
}
function getPerDayNeeded() {
  if (!state.goal) return null;
  const remaining = Math.max(0, Number(state.goal.target) - getSaved());
  const left = getDaysLeft();
  if (left === null || left <= 0) return remaining;
  return remaining / left;
}
function cheerFor(percent, daysLeft) {
  if (!state.goal) return "Let's start your first quest! 👇";
  if (percent >= 100) return "🎉 QUEST COMPLETE! You did it, money hero!";
  if (percent >= 75) return "🔥 So close! Final push — piggy is sweating!";
  if (percent >= 50) return "💪 Halfway hero! Keep feeding the piggy!";
  if (percent >= 25) return "🌱 Nice sprout! Your stack is growing!";
  if (percent > 0) return "🪙 Cha-ching! First coins in the jar!";
  if (daysLeft !== null && daysLeft < 0) return "⏰ Time's up! Launch a fresh quest!";
  return "🚀 Quest launched! Add your first earning!";
}

// ---------- Supabase data layer ----------
async function cloudLoad() {
  if (!supabaseClient) throw new Error("Supabase not configured. Add URL + anon key.");
  const { data: goals, error: gErr } = await supabaseClient
    .from("goals").select("*").order("created_at", { ascending: false }).limit(1);
  if (gErr) throw gErr;
  const goal = goals && goals[0] ? goals[0] : null;
  let entries = [];
  if (goal) {
    const { data, error } = await supabaseClient
      .from("earnings").select("*").eq("goal_id", goal.id).order("date", { ascending: false });
    if (error) throw error;
    entries = (data || []).map((r) => ({ id: r.id, amount: r.amount, date: r.date, note: r.note || "" }));
  }
  if (goal) {
    state.goal = { id: goal.id, name: goal.name, target: Number(goal.target), days: Number(goal.days), start: goal.start_date };
    state.currency = goal.currency || state.currency;
  } else {
    state.goal = null;
  }
  state.entries = entries;
}

async function cloudSaveGoal({ name, target, days, start, currency }) {
  // Keep one active quest: reuse latest goal row, else insert.
  const { data: existing } = await supabaseClient
    .from("goals").select("id").order("created_at", { ascending: false }).limit(1);
  if (existing && existing[0]) {
    const { data, error } = await supabaseClient.from("goals").update({
      name, target, days, start_date: start, currency
    }).eq("id", existing[0].id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabaseClient.from("goals").insert({
    name, target, days, start_date: start, currency
  }).select().single();
  if (error) throw error;
  return data;
}

async function cloudAddEarning({ goalId, amount, date, note }) {
  const { data, error } = await supabaseClient.from("earnings").insert({
    goal_id: goalId, amount, date, note
  }).select().single();
  if (error) throw error;
  return data;
}

async function cloudDeleteEarning(id) {
  const { error } = await supabaseClient.from("earnings").delete().eq("id", id);
  if (error) throw error;
}

async function cloudClearEarnings(goalId) {
  const { error } = await supabaseClient.from("earnings").delete().eq("goal_id", goalId);
  if (error) throw error;
}

async function cloudResetAll() {
  await supabaseClient.from("earnings").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await supabaseClient.from("goals").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

async function refreshFromCloudOrCache() {
  if (!supabaseClient) {
    const cached = loadLocal();
    if (cached) state = { ...state, ...cached };
    setCloudStatus("local", "💾 offline mode (no Supabase config)");
    render();
    return;
  }
  setCloudStatus("sync", "☁️ syncing…");
  try {
    await cloudLoad();
    cloudOK = true;
    cacheLocal();
    setCloudStatus("ok", "☁️ Supabase connected");
  } catch (err) {
    cloudOK = false;
    const cached = loadLocal();
    if (cached) state = { ...state, ...cached };
    setCloudStatus("local", "💾 offline — showing saved copy");
    console.warn("Supabase load failed, using cache:", err.message);
    toast("⚠️ Cloud unreachable — offline copy shown. Run supabase-schema.sql first!");
  }
  render();
}

// ---------- UI ----------
function render() {
  const saved = getSaved();
  const target = state.goal ? Number(state.goal.target) : 0;
  const percent = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
  const daysLeft = getDaysLeft();
  const perDay = getPerDayNeeded();
  const remaining = target > 0 ? Math.max(0, target - saved) : 0;

  $("savedLabel").textContent = money(saved);
  $("targetLabel").textContent = money(target);
  $("heroPercent").textContent = `${Math.floor(percent)}%`;
  $("heroDaysLeft").textContent = daysLeft === null ? "—" : (daysLeft < 0 ? "0" : daysLeft);
  $("heroPerDay").textContent = perDay === null ? "—" : money(Math.ceil(perDay));
  $("progressFill").style.width = percent + "%";
  $("progressCoin").style.left = percent + "%";
  $("jarFill").style.height = percent + "%";
  $("cheerMsg").textContent = cheerFor(percent, daysLeft);

  const face = $("piggyFace");
  if (percent >= 100) face.textContent = "🤩";
  else if (percent >= 75) face.textContent = "😎";
  else if (percent >= 50) face.textContent = "😋";
  else if (percent >= 25) face.textContent = "🙂";
  else if (percent > 0) face.textContent = "🐽";
  else face.textContent = "😴";
  face.style.transform = `scale(${1 + percent / 250}) rotate(${(percent % 10) - 5}deg)`;

  $("endDateLabel").textContent = prettyDate(getEndDate());
  $("perDayLabel").textContent = perDay === null ? "—" : money(Math.ceil(perDay));
  $("remainingLabel").textContent = target ? money(remaining) : "—";
  $("moneySymbol").textContent = state.currency;
  $("moneySymbol2").textContent = state.currency;
  $("currencySelect").value = state.currency;

  const list = $("logList");
  list.innerHTML = "";
  const sorted = [...state.entries].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  $("entryCount").textContent = sorted.length;
  $("emptyLog").style.display = sorted.length ? "none" : "block";
  for (const e of sorted) {
    const li = document.createElement("li");
    li.innerHTML = `<div class="log-coin">🪙</div>
      <div class="log-main"><b>${money(e.amount)}</b><small>${e.note ? escapeHtml(e.note) + " • " : ""}${e.date || ""}</small></div>
      <div class="log-amt">+${fmt(e.amount)}</div>
      <button class="log-del" title="Remove">❌</button>`;
    li.querySelector(".log-del").addEventListener("click", async () => {
      try {
        if (supabaseClient && cloudOK) await cloudDeleteEarning(e.id);
        state.entries = state.entries.filter((x) => x.id !== e.id);
        cacheLocal();
        render();
        toast("🗑️ Entry deleted!");
      } catch (err) {
        toast("⚠️ Delete failed: " + err.message);
      }
    });
    list.appendChild(li);
  }

  if (state.goal) {
    if (document.activeElement !== $("goalName")) $("goalName").value = state.goal.name || "";
    if (document.activeElement !== $("targetAmount")) $("targetAmount").value = state.goal.target || "";
    if (document.activeElement !== $("totalDays")) $("totalDays").value = state.goal.days || "";
    if (document.activeElement !== $("startDate")) $("startDate").value = state.goal.start || todayISO();
  }
}

let toastTimer;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3000);
}

function confettiBoom(big = false) {
  const box = $("confettiBoom");
  const emojis = ["🪙", "💰", "⭐", "🎉", "✨", "💸", "🍩"];
  const count = big ? 90 : 36;
  for (let i = 0; i < count; i++) {
    const s = document.createElement("span");
    s.className = "confetti-bit";
    s.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    s.style.left = Math.random() * 100 + "vw";
    s.style.fontSize = (0.9 + Math.random() * 1.8) + "rem";
    s.style.animationDuration = (1.6 + Math.random() * 1.8) + "s";
    box.appendChild(s);
    setTimeout(() => s.remove(), 3800);
  }
}

$("goalForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("goalName").value.trim() || "My Money Quest";
  const target = Number($("targetAmount").value);
  const days = Number($("totalDays").value);
  const start = $("startDate").value || todayISO();
  if (!(target > 0)) return toast("🤨 Enter a target amount above 0!");
  if (!(days > 0)) return toast("📅 Days must be at least 1!");
  try {
    if (supabaseClient) {
      const row = await cloudSaveGoal({ name, target, days, start, currency: state.currency });
      state.goal = { id: row.id, name: row.name, target: Number(row.target), days: Number(row.days), start: row.start_date };
      state.entries = [];
      cloudOK = true;
      setCloudStatus("ok", "☁️ Supabase connected");
    } else {
      state.goal = { id: null, name, target, days, start };
      state.entries = [];
    }
    cacheLocal();
    render();
    confettiBoom(false);
    toast(`🚀 "${name}" saved to Supabase! Earn ${money(Math.ceil(target / days))}/day!`);
  } catch (err) {
    toast("⚠️ Save failed: " + err.message + " — did you run supabase-schema.sql?");
  }
});

$("earnForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!state.goal) return toast("🗺️ Start a quest first!");
  const amount = Number($("earnAmount").value);
  if (!(amount > 0)) return toast("🤨 Amount must be above 0!");
  const payload = { amount, date: $("earnDate").value || todayISO(), note: $("earnNote").value.trim() };
  const before = getSaved();
  try {
    if (supabaseClient && state.goal.id) {
      const row = await cloudAddEarning({ goalId: state.goal.id, ...payload });
      state.entries.unshift({ id: row.id, amount: Number(row.amount), date: row.date, note: row.note || "" });
    } else if (supabaseClient && !state.goal.id) {
      throw new Error("Save the quest first so it has a cloud id, then add earnings.");
    } else {
      state.entries.unshift({ id: "e" + Date.now(), ...payload });
    }
    cacheLocal();
    render();
    $("earnAmount").value = "";
    $("earnNote").value = "";
    const after = getSaved();
    if (before < Number(state.goal.target) && after >= Number(state.goal.target)) {
      confettiBoom(true);
      toast("🎉 GOAL SMASHED! Saved to Supabase!");
    } else {
      confettiBoom(false);
      toast(`🪙 +${money(amount)} saved to Supabase! Total ${money(after)}!`);
    }
  } catch (err) {
    toast("⚠️ Add failed: " + err.message);
  }
});

document.querySelectorAll("[data-quick]").forEach((b) => {
  b.addEventListener("click", () => {
    $("earnAmount").value = Number($("earnAmount").value || 0) + Number(b.dataset.quick);
    $("earnAmount").focus();
  });
});

$("currencySelect").addEventListener("change", async (e) => {
  state.currency = e.target.value;
  try {
    if (supabaseClient && state.goal && state.goal.id) {
      const { error } = await supabaseClient.from("goals").update({ currency: state.currency }).eq("id", state.goal.id);
      if (error) throw error;
    }
  } catch (err) { toast("⚠️ Currency save failed: " + err.message); }
  cacheLocal();
  render();
  toast(`💱 Currency: ${state.currency}`);
});

$("resetBtn").addEventListener("click", async () => {
  if (!confirm("Reset everything? Quest + log cleared in Supabase too! 🧹")) return;
  try {
    if (supabaseClient) await cloudResetAll();
  } catch (err) { toast("⚠️ Cloud reset failed: " + err.message); }
  state = { goal: null, entries: [], currency: state.currency };
  cacheLocal();
  $("goalForm").reset();
  $("earnForm").reset();
  initDates();
  render();
  toast("↺ Fresh start! New quest time!");
});

$("clearLogBtn").addEventListener("click", async () => {
  if (!state.entries.length) return toast("📒 Log is already empty!");
  if (!confirm("Clear all earnings? Goal stays, log goes!")) return;
  try {
    if (supabaseClient && state.goal && state.goal.id) await cloudClearEarnings(state.goal.id);
    state.entries = [];
    cacheLocal();
    render();
    toast("🧹 Treasure log cleared in Supabase!");
  } catch (err) { toast("⚠️ Clear failed: " + err.message); }
});

function initDates() {
  if (!$("startDate").value) $("startDate").value = todayISO();
  if (!$("earnDate").value) $("earnDate").value = todayISO();
}

initDates();
refreshFromCloudOrCache();
