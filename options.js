const form = document.getElementById("form");
const saved = document.getElementById("saved");
const detectBtn = document.getElementById("detectBtn");
const detectNote = document.getElementById("detectNote");
const learnedList = document.getElementById("learnedList");
const learnedEmpty = document.getElementById("learnedEmpty");
const learnedClearAll = document.getElementById("learnedClearAll");
const geoIranLookup = document.getElementById("geoIranLookup");
const geoStatus = document.getElementById("geoStatus");
const geoClear = document.getElementById("geoClear");
const autoFailover = document.getElementById("autoFailover");
const healthStatus = document.getElementById("healthStatus");
const healthCheckNow = document.getElementById("healthCheckNow");

let loaded = { ...DEFAULT_SETTINGS };

init();

async function init() {
  loaded = await chrome.runtime.sendMessage({ type: "getSettings" });
  document.getElementById("proxyScheme").value = loaded.proxyScheme;
  document.getElementById("proxyHost").value = loaded.proxyHost;
  document.getElementById("proxyPort").value = loaded.proxyPort;
  document.getElementById("useIrTld").checked = loaded.useIrTld;
  document.getElementById("useDefaultIranSites").checked = loaded.useDefaultIranSites;
  document.getElementById("mirrorIranianBrands").checked = loaded.mirrorIranianBrands !== false;
  geoIranLookup.checked = loaded.geoIranLookup === true;
  autoFailover.checked = loaded.autoFailover !== false;
  document.getElementById("bypassList").value = (loaded.bypassList || []).join("\n");
  document.getElementById("proxyList").value = (loaded.proxyList || []).join("\n");
  renderLearned();
  refreshGeoStatus();
  refreshHealthStatus();
}

async function refreshHealthStatus() {
  const info = await chrome.runtime.sendMessage({ type: "healthInfo" });
  const state = info?.ok === true ? "ok" : info?.degraded ? "down" : info?.ok === false ? "warn" : "idle";
  const when = info?.checkedAt ? new Date(info.checkedAt).toLocaleTimeString("fa-IR") : "—";
  const map = {
    ok: "تونل فعال است",
    down: "تونل قطع است و فعلاً از پروکسی سیستم استفاده می‌شود",
    warn: "تونل پاسخ نداد",
    idle: "هنوز بررسی نشده"
  };
  healthStatus.textContent = `${map[state]} (آخرین بررسی: ${when})`;
}

healthCheckNow.addEventListener("click", async () => {
  healthCheckNow.disabled = true;
  healthStatus.textContent = "در حال بررسی اتصال...";
  await chrome.runtime.sendMessage({ type: "healthCheck" });
  loaded = await chrome.runtime.sendMessage({ type: "getSettings" });
  document.getElementById("proxyHost").value = loaded.proxyHost;
  document.getElementById("proxyPort").value = loaded.proxyPort;
  document.getElementById("proxyScheme").value = loaded.proxyScheme;
  healthCheckNow.disabled = false;
  refreshHealthStatus();
});

async function refreshGeoStatus() {
  const info = await chrome.runtime.sendMessage({ type: "geoInfo" });
  const hosts = info?.hosts || [];
  geoStatus.textContent = hosts.length
    ? `${hosts.length} میزبان ایرانی با موقعیت سرور کشف شده (${info.cached || 0} مورد بررسی‌شده).`
    : "هنوز میزبانی با موقعیت سرور ایران کشف نشده.";
  geoClear.disabled = hosts.length === 0 && !info?.cached;
}

geoClear.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "geoClear" });
  refreshGeoStatus();
});

function renderLearned() {
  const entries = normalizeLearned(loaded.learned);
  learnedEmpty.hidden = entries.length > 0;
  learnedList.textContent = "";
  learnedClearAll.disabled = entries.length === 0;

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `learned-row ${entry.route}`;

    const host = document.createElement("code");
    host.textContent = entry.host;

    const tag = document.createElement("span");
    tag.className = "learned-tag";
    tag.textContent = entry.route === "direct" ? "مستقیم" : "با پروکسی";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "حذف";
    remove.addEventListener("click", async () => {
      loaded = await unlearnHost(loaded, entry.host);
      await chrome.runtime.sendMessage({ type: "saveSettings", settings: loaded });
      renderLearned();
    });

    row.append(host, tag, remove);
    learnedList.appendChild(row);
  }
}

learnedClearAll.addEventListener("click", async () => {
  loaded = { ...loaded, learned: [] };
  await chrome.runtime.sendMessage({ type: "saveSettings", settings: loaded });
  renderLearned();
});

detectBtn.addEventListener("click", async () => {
  detectBtn.disabled = true;
  detectNote.textContent = "اندازه‌گیری اتصال مستقیم...";
  try {
    const result = await chrome.runtime.sendMessage({ type: "detectProxy" });
    if (result?.found) {
      document.getElementById("proxyScheme").value = result.proxyScheme;
      document.getElementById("proxyHost").value = result.proxyHost;
      document.getElementById("proxyPort").value = result.proxyPort;

      const lines = [`${result.proxyHost}:${result.proxyPort} — ${result.recommendation.label}`];
      lines.push(`IP مستقیم ${result.baselineIp} ← IP تونل ${result.tunnelIp}`);
      if (result.mixedPort) {
        lines.push("نوع‌های پشتیبانی‌شده: " + result.supportedSchemes.join("، "));
      }
      for (const note of result.recommendation.notes || []) lines.push("• " + note);
      lines.push("برای اعمال، «ذخیره تنظیمات» را بزنید.");
      detectNote.textContent = lines.join("\n");
    } else if (result?.error) {
      detectNote.textContent = "خطای سرویس پس‌زمینه: " + result.error;
    } else if (!result) {
      detectNote.textContent = "سرویس پس‌زمینه پاسخ نداد. افزونه را در chrome://extensions دوباره بارگذاری کن.";
    } else {
      const lines = [result.message || ("دلیلی داده نشد [reason=" + (result.reason || "?") + "]")];
      if (result.allSameIp) lines.push("همه مسیرها از IP " + result.allSameIp + " عبور کردند.");
      const table = (result.diagnostics || [])
        .filter((d) => d.ok)
        .map((d) => `  پورت ${d.port}: ${d.scheme} → ${d.ip} (${d.ms}ms)`);
      if (table.length) lines.push("نمونه‌های پاسخ‌دهنده:", ...table);
      detectNote.textContent = lines.join("\n");
    }
  } catch (error) {
    detectNote.textContent = "خطا: " + String(error?.message || error);
  } finally {
    detectBtn.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const port = Number(document.getElementById("proxyPort").value);
  const settings = {
    proxyScheme: document.getElementById("proxyScheme").value,
    proxyHost: document.getElementById("proxyHost").value.trim() || "127.0.0.1",
    proxyPort: port >= 1 && port <= 65535 ? port : 1080,
    useIrTld: document.getElementById("useIrTld").checked,
    useDefaultIranSites: document.getElementById("useDefaultIranSites").checked,
    mirrorIranianBrands: document.getElementById("mirrorIranianBrands").checked,
    geoIranLookup: geoIranLookup.checked,
    autoFailover: autoFailover.checked,
    bypassList: parseDomainList(document.getElementById("bypassList").value),
    proxyList: parseDomainList(document.getElementById("proxyList").value)
  };
  await chrome.runtime.sendMessage({ type: "saveSettings", settings });
  saved.hidden = false;
  setTimeout(() => {
    saved.hidden = true;
  }, 1500);
});