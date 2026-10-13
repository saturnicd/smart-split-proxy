const enabledEl = document.getElementById("enabled");
const statusCard = document.getElementById("statusCard");
const statusTitle = document.getElementById("statusTitle");
const statusText = document.getElementById("statusText");
const currentHostEl = document.getElementById("currentHost");
const siteHint = document.getElementById("siteHint");
const routeChip = document.getElementById("routeChip");
const favicon = document.getElementById("favicon");
const bypassBtn = document.getElementById("bypassBtn");
const proxyBtn = document.getElementById("proxyBtn");
const detectBtn = document.getElementById("detectBtn");
const detectNote = document.getElementById("detectNote");
const progress = document.getElementById("detectProgress");
const overrideBar = document.getElementById("overrideBar");
const overrideText = document.getElementById("overrideText");
const overrideChip = document.getElementById("overrideChip");
const overrideCount = document.getElementById("overrideCountdown");
const overrideClear = document.getElementById("overrideClear");
const tempProxyBtn = document.getElementById("tempProxyBtn");
const tempDirectBtn = document.getElementById("tempDirectBtn");
const buildTag = document.getElementById("buildTag");
const learnedNote = document.getElementById("learnedNote");
const learnedText = document.getElementById("learnedText");
const learnedClear = document.getElementById("learnedClear");
const geoBox = document.getElementById("geoBox");
const geoBtn = document.getElementById("geoBtn");
const geoNote = document.getElementById("geoNote");
const healthDot = document.getElementById("healthDot");
const healthText = document.getElementById("healthText");
const healthHost = document.getElementById("healthHost");
const healthCheck = document.getElementById("healthCheck");
const toastEl = document.getElementById("toast");
const modesEl = document.querySelector(".modes");
const tempBtnsEl = document.querySelector(".temp-btns");

let settings = { ...DEFAULT_SETTINGS };
let currentHost = "";
let currentTabId = null;
let override = null;
let geoHosts = [];
let toastTimer = null;

function toast(message, kind = "ok") {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  void toastEl.offsetWidth; // restart the transition on repeat calls
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", async () => {
    settings.mode = button.dataset.mode;
    await save();
  });
});

enabledEl.addEventListener("change", async () => {
  settings.enabled = enabledEl.checked;
  await save();
});

bypassBtn.addEventListener("click", async () => {
  if (!currentHost) return;
  settings = learnHost(settings, currentHost, "direct");
  await save();
});

proxyBtn.addEventListener("click", async () => {
  if (!currentHost) return;
  settings = learnHost(settings, currentHost, "proxy");
  await save();
});

overrideClear.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearOverride" });
  override = null;
  render();
  await reloadCurrentTab();
});

learnedClear.addEventListener("click", async () => {
  if (!currentHost) return;
  settings = unlearnHost(settings, currentHost);
  await save();
});

geoBtn.addEventListener("click", async () => {
  if (!currentHost) return;
  geoBtn.disabled = true;
  geoNote.textContent = "در حال بررسی...";
  const result = await chrome.runtime.sendMessage({ type: "geoCheckHost", host: currentHost });
  geoBtn.disabled = false;
  const info = await chrome.runtime.sendMessage({ type: "geoInfo" });
  geoHosts = info?.hosts || [];
  if (!result || result.ok === false) {
    geoNote.textContent = "بررسی ناموفق بود؛ بعداً دوباره تلاش کن.";
  } else if (result.ir) {
    geoNote.textContent = `میزبان ایرانی تشخیص داده شد (${result.cc || result.asn || "IR"}) — مسیر مستقیم اعمال شد.`;
  } else {
    geoNote.textContent = `میزبان ایرانی نیست (${result.cc || "نامشخص"}).`;
  }
  render();
});

healthCheck.addEventListener("click", async () => {
  healthCheck.disabled = true;
  healthText.textContent = "در حال بررسی اتصال...";
  if (healthDot) healthDot.className = "dot checking";
  await chrome.runtime.sendMessage({ type: "healthCheck" });
  settings = await chrome.runtime.sendMessage({ type: "getSettings" });
  override = await chrome.runtime.sendMessage({ type: "getOverride" });
  const info = await chrome.runtime.sendMessage({ type: "healthInfo" });
  healthCheck.disabled = false;
  renderHealth(info);
  render();
  toast(info?.ok ? "تونل فعال است" : "تونل پاسخ نداد", info?.ok ? "ok" : "warn");
});

// Temporary per-tab routing. Chrome's proxy API is global, so this forces the
// whole browser into that mode and auto-reverts when the tab closes or the
// override expires. The tab itself is reloaded once the mode is live.
tempProxyBtn.addEventListener("click", () => setTemp("proxy"));
tempDirectBtn.addEventListener("click", () => setTemp("direct"));

async function setTemp(mode) {
  if (!currentHost) return;
  const result = await chrome.runtime.sendMessage({
    type: "setOverride",
    host: currentHost,
    mode
  });
  override = result?.override || null;
  render();
  toast(mode === "direct" ? "مسیر این تب: مستقیم" : "مسیر این تب: از پروکسی", mode === "direct" ? "warn" : "ok");
  await reloadCurrentTab();
}

detectBtn.addEventListener("click", async () => {
  detectBtn.disabled = true;
  detectBtn.textContent = "در حال بررسی...";
  detectNote.textContent = "اندازه‌گیری اتصال مستقیم...";
  progress.textContent = "";
  progress.hidden = false;
  progressTimer = setInterval(pollProgress, 400);

  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: "detectProxy" });
  } catch (error) {
    clearInterval(progressTimer);
    detectNote.textContent = "خطا در تشخیص: " + String(error?.message || error);
    progress.hidden = true;
    detectBtn.disabled = false;
    detectBtn.textContent = "تشخیص خودکار پروکسی";
    return;
  }

  clearInterval(progressTimer);
  progress.hidden = true;
  detectBtn.disabled = false;
  detectBtn.textContent = "تشخیص خودکار پروکسی";

  if (result?.found) {
    settings.proxyScheme = result.proxyScheme;
    settings.proxyHost = result.proxyHost;
    settings.proxyPort = result.proxyPort;
    await save({ reload: false });

    const lines = [];
    lines.push(`${result.proxyHost}:${result.proxyPort} — ${result.recommendation.label}`);
    lines.push(`IP مستقیم ${result.baselineIp} ← IP تونل ${result.tunnelIp}`);
    if (result.mixedPort) {
      lines.push("نوع‌های پشتیبانی‌شده: " + result.supportedSchemes.join("، "));
    }
    for (const note of result.recommendation.notes || []) lines.push("• " + note);
    detectNote.textContent = lines.join("\n");
  } else if (result?.error) {
    // The service worker rejected the request. Never hide this behind a generic
    // "not found" message.
    detectNote.textContent = "خطای سرویس پس‌زمینه: " + result.error;
  } else if (!result) {
    detectNote.textContent =
      "سرویس پس‌زمینه پاسخ نداد. افزونه را در chrome://extensions دوباره بارگذاری کن.";
  } else {
    // Surface the reason, not just the conclusion: the difference between
    // "no IP service answered" and "everything is on the same exit IP" tells
    // the user whether their filter-breaker is even running.
    const lines = [];
    lines.push(result.message || ("دلیلی داده نشد [reason=" + (result.reason || "?") + "]"));
    if (result.allSameIp) lines.push("همه مسیرها از IP " + result.allSameIp + " عبور کردند.");
    const table = (result.diagnostics || [])
      .filter((d) => d.ok)
      .map((d) => `پورت ${d.port}: ${d.scheme} → ${d.ip} (${d.ms}ms)`);
    if (table.length) lines.push("نمونه‌های پاسخ‌دهنده:", ...table);
    detectNote.textContent = lines.join("\n");
  }
  render();
});

init();

let progressTimer = null;

async function pollProgress() {
  const step = await chrome.runtime.sendMessage({ type: "detectProgress" });
  if (!step) return;
  if (step.phase === "baseline") {
    progress.textContent = "اندازه‌گیری اتصال مستقیم...";
  } else if (step.phase === "scan") {
    progress.textContent = `بررسی پورت ${step.port} (${step.tested + 1} از ${step.total})`;
  }
}

async function init() {
  if (buildTag) buildTag.textContent = "نسخهٔ تشخیص: " + BUILD_TAG;
  settings = await chrome.runtime.sendMessage({ type: "getSettings" });
  override = await chrome.runtime.sendMessage({ type: "getOverride" });
  if (settings.geoIranLookup) {
    const info = await chrome.runtime.sendMessage({ type: "geoInfo" });
    geoHosts = info?.hosts || [];
  }
  startOverrideTick();

  const healthInfo = await chrome.runtime.sendMessage({ type: "healthInfo" });
  renderHealth(healthInfo);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id ?? null;
  currentHost = tab?.url ? normalizeHost(tab.url) : "";

  currentHostEl.textContent = currentHost || "این صفحه دامنه وب ندارد";
  bypassBtn.disabled = !currentHost;
  proxyBtn.disabled = !currentHost;
  tempProxyBtn.disabled = !currentHost;
  tempDirectBtn.disabled = !currentHost;

  if (currentHost) {
    favicon.hidden = false;
    favicon.src = chrome.runtime.getURL(
      "/_favicon/?pageUrl=" + encodeURIComponent(tab.url) + "&size=32"
    );
  }
  render();
}

async function save(options = {}) {
  await chrome.runtime.sendMessage({ type: "saveSettings", settings });
  render();
  toast("ذخیره شد");
  if (options.reload !== false) await reloadCurrentTab();
}

async function reloadCurrentTab() {
  if (!currentTabId) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && tab.url && /^https?:/.test(tab.url)) {
    chrome.tabs.reload(tab.id);
  }
}

let overrideTick = null;

function updateOverrideCount() {
  if (!override?.expiresAt) {
    if (overrideCount) overrideCount.textContent = "";
    return;
  }
  const leftMs = Math.max(0, override.expiresAt - Date.now());
  const m = Math.floor(leftMs / 60000);
  const s = Math.floor((leftMs % 60000) / 1000);
  overrideCount.textContent = `${m}:${String(s).padStart(2, "0")}`;
  overrideCount.title = "باقی‌ماندهٔ زمان مسیر موقت";
}

function startOverrideTick() {
  if (overrideTick) return;
  overrideTick = setInterval(updateOverrideCount, 1000);
}

function renderHealth(info) {
  if (!healthDot || !healthText) return;
  const state = info?.ok === true ? "ok" : info?.degraded ? "down" : info?.ok === false ? "warn" : "idle";
  healthDot.className = `dot ${state}`;

  let text;
  if (info?.skipped === "override") text = "بررسی موقتاً معلق (مسیر موقت فعال است)";
  else if (state === "ok") text = "تونل فعال است";
  else if (state === "down") text = "تونل قطع — موقتاً مستقیم";
  else if (state === "warn") text = "تونل پاسخ نداد";
  else text = "وضعیت اتصال نامشخص";

  if (state === "down" && info?.autoFailover === false) {
    text += " — جایگزینی خودکار خاموش است";
  }
  healthText.textContent = text;

  const hostLabel =
    (state === "ok" || state === "down") && info?.host
      ? `${info.host}:${info.port || "?"}`
      : "";
  if (healthHost) {
    healthHost.textContent = hostLabel;
    healthHost.hidden = !hostLabel;
  }
}

function render() {
  enabledEl.checked = Boolean(settings.enabled);

  document.querySelectorAll(".mode").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === settings.mode);
  });

  if (modesEl) {
    const order = ["smart", "proxy", "direct"];
    const index = order.indexOf(settings.mode);
    modesEl.style.setProperty("--seg-i", index < 0 ? 0 : index);
    modesEl.dataset.active = index < 0 ? "smart" : settings.mode;
  }

  const usingProxy = settings.enabled && settings.mode !== "direct";
  statusCard.className = `status ${usingProxy ? "proxy" : "direct"}${settings.enabled ? "" : " idle"}`;

  if (!settings.enabled) {
    statusTitle.textContent = "افزونه خاموش است";
    statusText.textContent = "مرورگر از تنظیم پروکسی سیستم استفاده می‌کند.";
  } else if (settings.mode === "direct") {
    statusTitle.textContent = "همه مستقیم";
    statusText.textContent = "هیچ سایتی از پروکسی عبور نمی‌کند.";
  } else if (settings.mode === "proxy") {
    statusTitle.textContent = "همه با پروکسی";
    statusText.textContent = `تونل فعال روی ${settings.proxyHost}:${settings.proxyPort}`;
  } else {
    statusTitle.textContent = "حالت هوشمند";
    statusText.textContent = "سایت ایرانی مستقیم، بقیه از پروکسی محلی.";
  }

  if (override?.host) {
    overrideBar.hidden = false;
    const directOverride = override.mode === "direct";
    overrideBar.className = `override ${directOverride ? "direct-override" : "proxy-override"}`;
    overrideChip.textContent = directOverride ? "مستقیم" : "پروکسی";
    overrideText.textContent = override.host;
    updateOverrideCount();
  } else {
    overrideBar.hidden = true;
    overrideCount.textContent = "";
  }
  tempProxyBtn.classList.toggle("active", override?.host && override.mode !== "direct");
  tempDirectBtn.classList.toggle("active", override?.host && override.mode === "direct");

  if (tempBtnsEl) {
    const tempMode = override?.host ? (override.mode === "direct" ? "direct" : "proxy") : "";
    tempBtnsEl.dataset.active = tempMode;
    tempBtnsEl.style.setProperty("--seg-i", tempMode === "direct" ? 1 : 0);
  }

  if (!currentHost) {
    siteHint.textContent = "";
    routeChip.textContent = "—";
    routeChip.className = "chip";
    if (geoBox) geoBox.hidden = true;
    return;
  }

  // Single source of truth, shared with the service worker and the PAC script.
  const routeSettings = { ...settings, geoIranHosts: geoHosts };
  const direct = routeFor(currentHost, routeSettings) === "direct";
  routeChip.textContent = direct ? "مستقیم" : "پروکسی";
  routeChip.className = `chip ${direct ? "direct" : "proxy"}`;
  siteHint.textContent = direct
    ? "این سایت بدون فیلترشکن باز می‌شود."
    : "این سایت از پروکسی محلی عبور می‌کند.";

  const learnedRoute = learnedRouteFor(currentHost, settings.learned);
  if (learnedNote && learnedRoute) {
    learnedNote.hidden = false;
    learnedText.textContent =
      "یاد گرفتی که همیشه " + (learnedRoute === "direct" ? "مستقیم" : "با پروکسی") + " برود.";
  } else if (learnedNote) {
    learnedNote.hidden = true;
    learnedNote.textContent = "";
  }

  if (geoBox) {
    geoBox.hidden = !(settings.geoIranLookup && !direct);
  }
}