importScripts("defaults.js", "shared.js", "detect.js");

const STORAGE_KEY = "settings";
const OVERRIDE_KEY = "override";
const OVERRIDE_TTL_MS = 10 * 60 * 1000;
const GEO_KEY = "geoState";
const GEO_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GEO_MAX_HOSTS = 1000;
const GEO_MAX_CACHE = 800;
const GEO_TIMEOUT_MS = 6000;
const HEALTH_KEY = "health";
const HEALTH_ALARM = "tunnel-health";
const HEALTH_PERIOD_MIN = 3;
const FAILOVER_SCHEMES = ["socks5", "http"];
const FAILOVER_BUDGET_MS = 25000;

console.log("[smart-split-proxy] service worker loaded, build:", BUILD_TAG);

let lastProxyError = null;
let detectRun = 0;
let detectProgress = null;

init();

async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
  }

  // Do NOT blindly apply our settings on startup. If the browser already has a
  // working system proxy (GNOME "manual", v2rayN, Clash...), applying the
  // extension default here would silently break the user's connection.
  const current = await getSettings();
  const effective = await readEffectiveProxyConfig();

  const usable = current.enabled && current.mode !== "direct"
    ? await proxyIsUsable(current)
    : false;

  if (usable) {
    // Record "healthy" first: applyProxy() refuses to push config while the
    // health state still says the tunnel is dead.
    await saveHealth(healthyHealth(current));
    await applyProxy();
  } else {
    // Stored proxy is dead. Try to adopt whatever the browser already uses.
    const adopted = await adoptExistingProxy(current, effective);
    if (!adopted) {
      // Nothing usable anywhere. Do NOT push our dead settings onto the
      // browser (that would override the OS/system proxy the user relies on);
      // leave proxy control to the OS and tell the user via the badge.
      await chrome.proxy.settings.clear({ scope: "regular" });
      await setBadge("none", "#6b7280");
      await saveHealth({
        ok: false,
        checkedAt: Date.now(),
        degraded: true,
        host: sanitizeHost(current.proxyHost),
        port: Number(current.proxyPort) || null,
        reason: "startup"
      });
      console.warn(
        "[smart-split-proxy] stored proxy is unreachable and nothing could " +
        "be adopted; leaving the browser on its system proxy."
      );
    } else {
      await saveHealth(healthyHealth(await getSettings()));
    }
  }
  chrome.alarms.create("override-watchdog", { periodInMinutes: 1 });
  chrome.alarms.create(HEALTH_ALARM, { periodInMinutes: HEALTH_PERIOD_MIN });
}

/** Cheap check: is the configured host:port answering at all? */
async function proxyIsUsable(settings) {
  const config = {
    scheme: chromeScheme(settings.proxyScheme),
    host: sanitizeHost(settings.proxyHost),
    port: Number(settings.proxyPort) || 1080
  };
  const snapshot = await captureProxyState();
  try {
    const result = await testCandidateStandalone(config.scheme, config.host, config.port);
    return Boolean(result.ok);
  } finally {
    await restoreProxyState(snapshot);
  }
}

/**
 * If the browser already points at a local proxy, adopt it into our settings
 * instead of overwriting it. This is the common case on desktop setups where a
 * filter-breaker manages the system proxy.
 */
async function adoptExistingProxy(settings, effective) {
  const servers = [
    ...(effective?.servers || []),
    ...parsePacServers(effective?.pacScript)
  ].filter((server) => server && /^[\w.:-]+$/.test(String(server.host)) && server.port > 0);

  if (!servers.length) return false;

  const preferred = servers[0];
  const snapshot = await captureProxyState();
  let probe;
  try {
    probe = await testCandidateStandalone(preferred.scheme, preferred.host, preferred.port);
  } finally {
    await restoreProxyState(snapshot);
  }
  if (!probe.ok) return false;

  const next = {
    ...settings,
    proxyScheme: chromeScheme(preferred.scheme),
    proxyHost: preferred.host,
    proxyPort: preferred.port
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  await saveHealth(healthyHealth(next));
  await applyProxy({ force: true });
  return true;
}

chrome.runtime.onInstalled.addListener(async () => {
  await init();
});

chrome.runtime.onStartup.addListener(async () => {
  await init();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "override-watchdog") await applyProxy();
  else if (alarm.name === HEALTH_ALARM) await checkTunnelHealth();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    applyProxy().catch(reportProxyError);
  }
});

chrome.proxy.onProxyError.addListener((error) => {
  lastProxyError = error?.error || String(error);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const override = await getOverride();
  if (override && override.tabId === tabId) {
    await clearOverride();
    await applyProxy();
  }
});

// Opt-in: learn Iranian-hosted sites as the user browses. Fully asynchronous —
// the PAC router cannot do network I/O, so a discoverd host is applied on the
// next request (the first page load of a brand-new site still goes via proxy).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (changeInfo.status === "complete" ? tab.url : null);
  if (url) noteNavigation(url).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    getSettings: async () => getSettings(),
    saveSettings: async () => saveSettings(message.settings),
    applyProxy: async () => {
      await applyProxy();
      return { ok: true };
    },
    detectProxy: async () => runDetection(),
    detectProgress: async () => detectProgress,
    cancelDetect: async () => {
      detectRun++;
      detectProgress = null;
      return { ok: true };
    },
    probeProxy: async () => probeProxy(message.target),
    setOverride: async () => setOverride(sender.tab?.id, message),
    clearOverride: async () => {
      await clearOverride();
      await applyProxy();
      return { ok: true };
    },
    getOverride: async () => getOverride(),
    geoInfo: async () => {
      const state = await getGeoState();
      return { enabled: (await getSettings()).geoIranLookup, hosts: state.hosts, cached: Object.keys(state.cache).length };
    },
    geoCheckHost: async () => geoCheckHost(message.host, true),
    geoClear: async () => {
      await saveGeoState({ hosts: [], cache: {} });
      await applyProxy();
      return { ok: true };
    },
    healthInfo: async () => {
      const settings = await getSettings();
      return {
        ...(await getHealth()),
        autoFailover: settings.autoFailover !== false,
        proxyHost: sanitizeHost(settings.proxyHost),
        proxyPort: Number(settings.proxyPort) || null,
        checked: Number.isFinite((await getHealth()).checkedAt)
      };
    },
    healthCheck: async () => checkTunnelHealth(),
    getStatus: async () => ({ error: lastProxyError, proxyError: lastProxyError })
  };

  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve(handler())
    .then(sendResponse)
    .catch((error) => sendResponse({ error: String(error?.message || error) }));
  return true;
});

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] || {}) };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  // An explicit save means the user (or failover) chose this config on purpose,
  // so drop any "tunnel is dead, leave the system proxy alone" state.
  const health = await getHealth();
  if (health.degraded) await saveHealth({ ...health, degraded: false, ok: null, reason: "settings-changed" });
  // Apply before answering so callers can safely reload the tab afterwards.
  await applyProxy({ force: true });
  return { ok: true, settings: next };
}

async function getOverride() {
  const stored = await chrome.storage.local.get(OVERRIDE_KEY);
  const value = stored[OVERRIDE_KEY];
  if (!value) return null;
  if (value.expiresAt && value.expiresAt < Date.now()) {
    await clearOverride();
    return null;
  }
  return value;
}

async function setOverride(tabId, message) {
  const current = await getOverride();
  if (message.active === false) {
    await clearOverride();
    await applyProxy();
    return { ok: true, override: null };
  }
  const value = {
    tabId: tabId ?? null,
    host: normalizeHost(message.host),
    mode: message.mode === "direct" ? "direct" : "proxy",
    expiresAt: Date.now() + OVERRIDE_TTL_MS
  };
  if (!value.host) return { ok: false, error: "no-host" };
  await chrome.storage.local.set({ [OVERRIDE_KEY]: value });
  await applyProxy();
  return { ok: true, override: value, previous: current };
}

async function clearOverride() {
  await chrome.storage.local.remove(OVERRIDE_KEY);
}

async function applyProxy({ force = false } = {}) {
  const settings = await getSettings();
  const override = await getOverride();

  const effective = { ...settings };
  if (override?.host) {
    if (override.mode === "direct") {
      effective.mode = "direct";
    } else {
      effective.mode = "proxy";
    }
  }
  // Geo-discovered Iranian hosts live in their own storage key, never in the
  // settings blob (so a popup save can never clobber them).
  effective.geoIranHosts = effective.geoIranLookup !== false ? (await getGeoState()).hosts : [];

  // If the tunnel is known-dead we deliberately left the browser on its system
  // proxy; do not overwrite that until a health check confirms it is back (or
  // the user explicitly changes settings, which calls us with force:true).
  const blockedByHealth = !force && !override?.host && (await getHealth()).degraded === true;

  try {
    if (!effective.enabled || effective.mode === "direct") {
      await chrome.proxy.settings.clear({ scope: "regular" });
      await setBadge("off", "#6b7280");
      return;
    }

    if (blockedByHealth) {
      await chrome.proxy.settings.clear({ scope: "regular" });
      await setBadge("off", "#b91c1c");
      return;
    }

    const proxyConfig = {
      scheme: chromeScheme(effective.proxyScheme),
      host: sanitizeHost(effective.proxyHost),
      port: Number(effective.proxyPort) || 1080
    };

    if (needsPac(effective)) {
      await chrome.proxy.settings.set({
        value: {
          mode: "pac_script",
          pacScript: { data: buildPac(effective, proxyConfig), mandatory: true }
        },
        scope: "regular"
      });
    } else {
      await chrome.proxy.settings.set({
        value: {
          mode: "fixed_servers",
          rules: { singleProxy: proxyConfig, bypassList: buildBypassList(effective) }
        },
        scope: "regular"
      });
    }

    lastProxyError = null;
    const label = effective.mode === "proxy" ? "all" : "auto";
    await setBadge(label, "#0f766e");
  } catch (error) {
    await reportProxyError(error);
  }
}

async function reportProxyError(error) {
  lastProxyError = error?.message || String(error);
  await setBadge("err", "#b91c1c");
  console.warn("[smart-split-proxy] proxy error:", lastProxyError);
}

// ---------------------------------------------------------------------------
// Reliability: tunnel health check + automatic failover
// ---------------------------------------------------------------------------
//
// The failure that actually hurts is silent: the local proxy client (v2rayN,
// Clash, ...) dies, and because we forced fixed_servers every request now hangs
// until it times out. A periodic check detects that and recovers:
//   1. probe the configured host:port (cheap, one egress read);
//   2. if dead, probe a short list of other common local ports and switch to
//      the first one that answers;
//   3. if nothing answers, stop forcing the dead tunnel (leave the system
//      proxy in charge) and keep re-probing until it comes back.
// `degraded` records state (3): while true we must not re-apply our config.

function healthyHealth(settings) {
  return {
    ok: true,
    checkedAt: Date.now(),
    degraded: false,
    host: sanitizeHost(settings.proxyHost),
    port: Number(settings.proxyPort) || null,
    reason: "healthy"
  };
}

async function getHealth() {
  const stored = await chrome.storage.local.get(HEALTH_KEY);
  const value = stored[HEALTH_KEY];
  return value && typeof value === "object" ? value : {};
}

async function saveHealth(health) {
  await chrome.storage.local.set({ [HEALTH_KEY]: health });
}

async function notify(title, message) {
  try {
    await chrome.notifications.create("", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message
    });
  } catch (_error) {
    // notifications permission missing or unavailable: badge still updates
  }
}

/** Probe other common local ports for a working proxy. Bounded by a budget so
 *  a background worker is never kept alive scanning forever. */
async function findWorkingAlternate(settings) {
  const currentPort = Number(settings.proxyPort);
  const ports = COMMON_PROXY_PORTS.filter((port) => port !== currentPort).slice(0, 8);
  const started = Date.now();

  for (const port of ports) {
    if (Date.now() - started > FAILOVER_BUDGET_MS) break;
    for (const scheme of FAILOVER_SCHEMES) {
      const snapshot = await captureProxyState();
      let probe;
      try {
        probe = await testCandidateStandalone(scheme, "127.0.0.1", port);
      } finally {
        await restoreProxyState(snapshot);
      }
      if (probe.ok) return { scheme, host: "127.0.0.1", port };
    }
  }
  return null;
}

async function checkTunnelHealth() {
  const settings = await getSettings();
  const previous = await getHealth();

  // Not routing through our proxy at all: nothing to guard.
  if (!settings.enabled || settings.mode === "direct") {
    await saveHealth({ ...previous, ok: null, degraded: false, checkedAt: Date.now(), reason: "disabled" });
    if (previous.degraded) await applyProxy();
    return { ok: null, reason: "disabled" };
  }

  // Never fight a live temporary override.
  if (await getOverride()) return { ...previous, skipped: "override" };

  if (await proxyIsUsable(settings)) {
    const recovered = previous.degraded === true;
    await saveHealth({ ...healthyHealth(settings), reason: recovered ? "recovered" : "healthy" });
    if (recovered) {
      await applyProxy();
      notify("تونل وصل شد", "اتصال پروکسی دوباره برقرار شد.");
    }
    return { ok: true, recovered };
  }

  // The configured tunnel is down.
  if (settings.autoFailover !== false) {
    const alt = await findWorkingAlternate(settings);
    if (alt) {
      // Clear the degraded flag first so applyProxy (inside saveSettings) is
      // allowed to push the new, live configuration.
      await saveHealth({ ok: true, checkedAt: Date.now(), degraded: false, host: alt.host, port: alt.port, reason: "failover" });
      await saveSettings({ proxyScheme: alt.scheme, proxyHost: alt.host, proxyPort: alt.port, autoFailover: settings.autoFailover });
      notify("تغییر خودکار پروکسی", "پورت " + alt.port + " پاسخ داد؛ اتصال به آن سوئیچ شد.");
      return { ok: true, failover: alt };
    }
  }

  // Nothing answers: stop forcing the dead tunnel and leave the system proxy.
  await chrome.proxy.settings.clear({ scope: "regular" });
  await setBadge("off", "#b91c1c");
  await saveHealth({
    ok: false,
    checkedAt: Date.now(),
    degraded: true,
    host: sanitizeHost(settings.proxyHost),
    port: Number(settings.proxyPort) || null,
    reason: "tunnel-down"
  });
  if (previous.degraded !== true) {
    notify("تونل قطع شد", "به‌طور موقت از پروکسی سیستم استفاده می‌شود و خودکار دوباره وصل می‌شود.");
  }
  return { ok: false, degraded: true };
}

// ---------------------------------------------------------------------------
// Proxy auto-detection
// ---------------------------------------------------------------------------

// NOTE: detect.js also exports detectProxy(). Both live in the same global
// scope via importScripts, so this wrapper must not reuse that name.
async function runDetection() {
  const run = ++detectRun;
  const settings = await getSettings();
  try {
    const result = await detectProxy(settings, (step) => {
      detectProgress = { ...step, at: Date.now() };
    });
    // The full per-port table is the only way to see what the user's browser
    // actually did. Log it always; the popup shows a shortened version.
    console.log("[smart-split-proxy] detection result:", result);
    return result;
  } catch (error) {
    // Surface the failure in the popup AND in the service-worker console
    // (chrome://extensions -> service worker -> Inspect), which is the only
    // place the real stack is visible.
    const message = error?.message || String(error);
    console.error("[smart-split-proxy] detection failed:", error);
    return { found: false, reason: "exception", message: "خطای غیرمنتظره در تشخیص: " + message };
  } finally {
    detectProgress = null;
    // detect.js restores the exact pre-scan configuration itself. Only re-apply
    // our own settings once the user explicitly saves them, otherwise we would
    // overwrite the system proxy they were already using.
  }
}

/** Check a user-specified host:port without scanning. */
async function probeProxy(target) {
  const run = ++detectRun;
  const settings = await getSettings();
  const snapshot = await captureProxyState();
  try {
    const candidate = {
      scheme: chromeScheme(target?.scheme || settings.proxyScheme),
      host: sanitizeHost(target?.host || settings.proxyHost),
      port: Number(target?.port) || Number(settings.proxyPort) || 1080
    };
    return await testCandidateStandalone(candidate.scheme, candidate.host, candidate.port);
  } finally {
    await restoreProxyState(snapshot);
  }
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text: String(text).slice(0, 4) });
  } catch (_error) {
    // action API unavailable
  }
}

// --- geo / ASN based Iranian-host discovery ---------------------------------
// Opt-in. When enabled, hosts the user visits are looked up once (cached for a
// week). If the host is hosted in Iran it is remembered as a "direct" domain.
// The hostname is only ever sent to the DNS/geo providers, never logged.

const GEO_MULTI_SUFFIX = new Set([
  "co.ir", "com.ir", "net.ir", "org.ir", "gov.ir", "ac.ir", "sch.ir", "id.ir",
  "co.uk", "org.uk", "gov.uk", "com.au", "co.jp", "com.br", "co.in", "com.tr"
]);

// A small, high-confidence set of Iranian network operators. country_code "IR"
// is the primary signal; these only widen detection for Iranian IP space that
// is geolocated elsewhere.
const IRAN_ASNS = new Set([58224, 12880, 197207, 44244, 31549, 16322, 43211]);

const geoInflight = new Set();

async function getGeoState() {
  const stored = await chrome.storage.local.get(GEO_KEY);
  const state = stored[GEO_KEY] || {};
  return {
    hosts: Array.isArray(state.hosts) ? state.hosts : [],
    cache: state.cache && typeof state.cache === "object" ? state.cache : {}
  };
}

async function saveGeoState(state) {
  await chrome.storage.local.set({ [GEO_KEY]: state });
}

/** Reduce a host to its registrable domain (example.com, digikala.co.ir). */
function registrableHost(host) {
  const h = normalizeHost(host);
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  if (parts.length >= 3 && GEO_MULTI_SUFFIX.has(parts.slice(-2).join("."))) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function parseAsn(value) {
  const n = parseInt(String(value || "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function isIranResult(result) {
  if (!result) return false;
  if (result.cc === "IR") return true;
  return result.asn !== null && IRAN_ASNS.has(result.asn);
}

async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal, headers });
    if (!response.ok) return null;
    return await response.json();
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a domain to { cc, asn } or null. Primary API takes the hostname;
 *  fallback resolves via DoH then geo-locates the IP (hostname not exposed). */
async function resolveHostGeo(domain) {
  const primary = await fetchJson("https://ipwhois.app/json/" + encodeURIComponent(domain));
  if (primary && primary.success !== false) {
    return { cc: primary.country_code || null, asn: parseAsn(primary.asn) };
  }
  const doh = await fetchJson(
    "https://cloudflare-dns.com/dns-query?name=" + encodeURIComponent(domain) + "&type=A",
    { accept: "application/dns-json" }
  );
  const ip = (doh?.Answer || []).find((a) => a.type === 1)?.data;
  if (!ip) return null;
  const geo = await fetchJson("https://ipwho.is/" + ip);
  if (!geo || geo.success === false) return null;
  return { cc: geo.country_code || null, asn: geo.connection?.asn ?? null };
}

async function geoCheckHost(host, force) {
  const domain = registrableHost(host);
  if (!domain) return { ok: false, reason: "no-host" };

  const settings = await getSettings();
  const state = await getGeoState();
  const cached = state.cache[domain];
  const fresh = cached && Date.now() - (cached.ts || 0) < GEO_TTL_MS;
  if (fresh && !force) {
    return { ok: true, host: domain, ir: cached.ir, cc: cached.cc, asn: cached.asn, cached: true };
  }

  const result = await resolveHostGeo(domain);
  if (!result) return { ok: false, reason: "lookup-failed", host: domain };

  const ir = isIranResult(result);
  state.cache[domain] = { ir, cc: result.cc, asn: result.asn, ts: Date.now() };
  pruneGeoCache(state);

  let added = false;
  if (ir && !state.hosts.includes(domain)) {
    state.hosts.push(domain);
    if (state.hosts.length > GEO_MAX_HOSTS) state.hosts = state.hosts.slice(-GEO_MAX_HOSTS);
    added = true;
  }
  await saveGeoState(state);

  if (added && settings.geoIranLookup !== false) {
    await applyProxy();
  }
  return { ok: true, host: domain, ir, cc: result.cc, asn: result.asn, added };
}

function pruneGeoCache(state) {
  const keys = Object.keys(state.cache);
  if (keys.length <= GEO_MAX_CACHE) return;
  const sorted = keys.sort((a, b) => (state.cache[a].ts || 0) - (state.cache[b].ts || 0));
  for (const key of sorted.slice(0, keys.length - GEO_MAX_CACHE)) delete state.cache[key];
}

async function noteNavigation(url) {
  if (!/^https?:/i.test(url || "")) return;
  const settings = await getSettings();
  if (!settings.enabled || settings.geoIranLookup === false || settings.mode !== "smart") return;

  const host = normalizeHost(url);
  if (!host || isLocalHost(host) || isPlainHostName(host)) return;

  // If the offline heuristics already send this direct, there is nothing to learn.
  if (routeFor(host, { ...settings, geoIranHosts: [] }) === "direct") return;

  const domain = registrableHost(host);
  if (geoInflight.has(domain)) return;
  geoInflight.add(domain);
  try {
    await geoCheckHost(domain, false);
  } finally {
    geoInflight.delete(domain);
  }
}