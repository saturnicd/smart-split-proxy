// Shared between the service worker, the popup and the options page.
// This file must stay free of any chrome.* API so it can be imported anywhere.

function normalizeHost(value) {
  if (!value) return "";
  try {
    if (value.includes("://")) {
      return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
    }
  } catch (_error) {
    // fall through to the manual parser
  }
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .replace(/^\*\./, "")
    .replace(/^\./, "");
}

function parseDomainList(text) {
  return [...new Set(
    String(text || "")
      .split(/\r?\n|,/)
      .map(normalizeHost)
      .filter(Boolean)
  )];
}

function hostInList(host, list) {
  const h = normalizeHost(host);
  return (list || []).some((domain) => h === domain || h.endsWith(`.${domain}`));
}

// --- auto-learned, per-site decisions --------------------------------------
// When the user forces a site direct/proxy, that decision is stored in
// settings.learned as [{host, route}]. Learned decisions override ALL static
// heuristics (.ir, default list, mode) so the extension learns the user's
// personal exceptions without them having to re-select every visit.

function normalizeLearned(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries || []) {
    const host = entry && entry.host ? normalizeHost(entry.host) : "";
    if (!host || seen.has(host)) continue;
    seen.add(host);
    result.push({ host, route: entry.route === "proxy" ? "proxy" : "direct" });
  }
  return result;
}

function learnedRouteFor(host, learned) {
  const h = normalizeHost(host);
  if (!h) return null;
  for (const entry of normalizeLearned(learned)) {
    if (h === entry.host || h.endsWith(`.${entry.host}`)) return entry.route;
  }
  return null;
}

/** Move a host into the learned list with an explicit route, removing any
 *  conflicting entry it has in the manual lists. Returns a new settings object. */
function learnHost(settings, host, route) {
  const h = normalizeHost(host);
  if (!h) return settings;
  const learned = normalizeLearned(settings.learned).filter((e) => e.host !== h);
  learned.push({ host: h, route: route === "direct" ? "direct" : "proxy" });
  return {
    ...settings,
    learned,
    proxyList: (settings.proxyList || []).filter((item) => normalizeHost(item) !== h),
    bypassList: (settings.bypassList || []).filter((item) => normalizeHost(item) !== h)
  };
}

/** Forget a learned decision and fall back to the automatic heuristics. */
function unlearnHost(settings, host) {
  const h = normalizeHost(host);
  return { ...settings, learned: normalizeLearned(settings.learned).filter((e) => e.host !== h) };
}

// --- Iranian brand "mirror-TLD" matching ------------------------------------
// A brand like digikala is listed on its canonical TLD (digikala.com), but the
// same brand often publishes on foreign TLDs too (digikala.ir, digikala.net).
// If the host's second-level label matches a known Iranian brand name, treat it
// as Iranian — regardless of which TLD the user happened to land on.

function iranianBrandNames() {
  if (typeof DEFAULT_IRAN_SITES === "undefined" || typeof MIRROR_BRAND_EXCLUDED === "undefined") {
    return [];
  }
  return [...new Set(
    DEFAULT_IRAN_SITES
      .map((d) => String(d).split(".")[0])
      .filter((name) => name && MIRROR_BRAND_EXCLUDED.indexOf(name) === -1)
  )];
}

function isIranianMirror(host, settings) {
  if (!settings) return false;
  if (settings.useDefaultIranSites === false || settings.mirrorIranianBrands === false) return false;
  const h = normalizeHost(host);
  const parts = h.split(".");
  if (parts.length < 2) return false;
  const sld = parts[parts.length - 2];
  return Boolean(sld) && iranianBrandNames().includes(sld);
}

// --- geo/IP-discovered Iranian hosts ----------------------------------------
// Opt-in. The background resolver looks up hosts the user visits and, when a
// host is hosted in Iran (country IR / an Iranian ASN), stores it here. These
// are concrete domains, so unlike mirror-matching they work in the native
// bypassList too. The caller is responsible for populating settings.geoIranHosts
// from geo storage; it is never written into the settings blob by the UI.

function geoDirectHosts(settings) {
  if (!settings || settings.geoIranLookup === false) return [];
  return Array.isArray(settings.geoIranHosts) ? settings.geoIranHosts : [];
}

// --- routing rules -------------------------------------------------------
// Every path (popup prediction, PAC generation, bypass list) must agree.
// Keep all of them derived from the helpers below.

function isLocalHost(host) {
  if (!host) return true;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    isPrivateIp(host)
  );
}

function isPrivateIp(host) {
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const m = /^172\.(\d{1,3})\./.exec(host);
  if (m) {
    const octet = Number(m[1]);
    return octet >= 16 && octet <= 31;
  }
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd");
}

// A bare hostname such as "router" or "intranet" has no public meaning.
function isPlainHostName(host) {
  return Boolean(host) && !host.includes(".");
}

/**
 * Single source of truth: where does this host go?
 * Returns "direct" or "proxy".
 */
function routeFor(host, settings) {
  const h = normalizeHost(host);
  if (!h) return "direct";
  if (!settings || !settings.enabled) return "direct";
  if (settings.mode === "direct") return "direct";

  if (isLocalHost(h) || isPlainHostName(h)) return "direct";

  // Auto-learned decisions override every heuristic below (.ir, default list,
  // proxy mode) — the point of learning is that the user knows better.
  const learned = learnedRouteFor(h, settings.learned);
  if (learned === "direct") return "direct";
  if (learned === "proxy") return "proxy";

  // Forced through the tunnel always wins, even for Iranian sites.
  if (hostInList(h, settings.proxyList)) return "proxy";

  if (settings.mode === "proxy") return "proxy";

  if (settings.useIrTld && (h === "ir" || h.endsWith(".ir"))) return "direct";

  const defaults = settings.useDefaultIranSites && typeof DEFAULT_IRAN_SITES !== "undefined"
    ? DEFAULT_IRAN_SITES
    : [];
  if (hostInList(h, [...defaults, ...geoDirectHosts(settings), ...(settings.bypassList || [])])) return "direct";

  // Well-known Iranian brand on a foreign/mirror TLD (digikala.net).
  if (isIranianMirror(h, settings)) return "direct";

  return "proxy";
}

/** Does the tunnel have to be forced for at least one host? (needs PAC) */
function needsPac(settings) {
  if (!settings || settings.mode !== "smart") return false;

  // Mirror-TLD matching can match _any_ TLD for a known brand; Chromium's
  // native bypassList cannot express that, so the PAC script must be the router.
  if (settings.useDefaultIranSites !== false && settings.mirrorIranianBrands !== false) {
    if (iranianBrandNames().length) return true;
  }

  const learnedProxy = normalizeLearned(settings.learned)
    .filter((e) => e.route === "proxy")
    .map((e) => e.host);
  const forced = [...new Set([
    ...(settings.proxyList || []).map(normalizeHost).filter(Boolean),
    ...learnedProxy
  ])];
  if (!forced.length) return false;
  // If a forced host would also be treated as direct by the plain bypass list,
  // Chromium's native bypassList cannot express it and we need a PAC script.
  return forced.some((host) => routeForIgnoringForced(host, settings) === "direct");
}

function routeForIgnoringForced(host, settings) {
  // Remove the explicit "forced" relations (proxyList + learned-proxy) but KEEP
  // learned-direct exceptions. A host can be both forced and learned-direct,
  // and the learned-direct decision still wins in routeFor; keeping it here
  // makes needsPac() see the conflict and force the PAC router — the only way
  // Chromium's fixed_servers+bypassList can express it.
  const clone = {
    ...settings,
    proxyList: [],
    learned: normalizeLearned(settings.learned).filter((e) => e.route === "direct")
  };
  return routeFor(host, clone);
}

/** The list of hosts the user explicitly wants through the tunnel (manual + learned). */
function forcedProxyHosts(settings) {
  return [...new Set([
    ...(settings.proxyList || []).map(normalizeHost).filter(Boolean),
    ...normalizeLearned(settings.learned)
      .filter((e) => e.route === "proxy")
      .map((e) => e.host)
  ])];
}

/** Chromium bypassList entries. Mirrors what the PAC checks. */
function buildBypassList(settings) {
  const patterns = new Set([
    "<local>",
    "localhost",
    "127.0.0.1",
    "[::1]",
    "*.local",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16"
  ]);

  const learned = normalizeLearned(settings.learned);

  if (settings.mode === "proxy") {
    // Everything proxies except learned-direct decisions and private hosts.
    for (const e of learned) {
      if (e.route !== "direct") continue;
      patterns.add(e.host);
      patterns.add(`*.${e.host}`);
    }
    return [...patterns];
  }

  const forced = forcedProxyHosts(settings);

  if (settings.useIrTld) patterns.add("*.ir");

  const defaults = settings.useDefaultIranSites && typeof DEFAULT_IRAN_SITES !== "undefined"
    ? DEFAULT_IRAN_SITES
    : [];

  const learnedDirect = learned.filter((e) => e.route === "direct").map((e) => e.host);

  const bypass = [...new Set(
    [...defaults, ...geoDirectHosts(settings), ...(settings.bypassList || []), ...learnedDirect].map(normalizeHost).filter(Boolean)
  )].filter((host) => !forced.some((domain) => host === domain || host.endsWith(`.${domain}`)));

  for (const host of bypass) {
    patterns.add(host);
    patterns.add(`*.${host}`);
  }

  return [...patterns];
}

function buildPac(settings, proxyConfig) {
  const defaults = settings.useDefaultIranSites && typeof DEFAULT_IRAN_SITES !== "undefined"
    ? DEFAULT_IRAN_SITES
    : [];
  const bypass = [...new Set(
    [...defaults, ...geoDirectHosts(settings), ...(settings.bypassList || [])].map(normalizeHost).filter(Boolean)
  )];
  const learned = normalizeLearned(settings.learned);
  const learnedDirect = learned.filter((e) => e.route === "direct").map((e) => e.host);
  const forceProxy = forcedProxyHosts(settings);
  const mirrorNames = iranianBrandNames();

  const server = pacScheme(settings.proxyScheme);

  return `
// Generated by Smart Split Proxy. Mirrors routeFor() in shared.js.
var SERVER = ${JSON.stringify(`${server} ${proxyConfig.host}:${proxyConfig.port}`)};
var BYPASS = ${JSON.stringify(bypass)};
var FORCED = ${JSON.stringify(forceProxy)};
var LEARNED_DIRECT = ${JSON.stringify(learnedDirect)};
var MIRROR = ${JSON.stringify(mirrorNames)};
var USE_MIRROR = ${settings.useDefaultIranSites !== false && settings.mirrorIranianBrands !== false ? "true" : "false"};
var USE_IR_TLD = ${settings.useIrTld ? "true" : "false"};
var ALL_PROXY = ${settings.mode === "proxy" ? "true" : "false"};

function norm(host) {
  host = (host || "").toLowerCase();
  if (host.charAt(0) === "[") {
    var end = host.indexOf("]");
    if (end !== -1) return host.substring(1, end);
  }
  return host;
}

function isPrivate(host) {
  if (/^127\\./.test(host) || /^10\\./.test(host) || /^192\\.168\\./.test(host)) return true;
  var m = /^172\\.(\\d{1,3})\\./.exec(host);
  if (m) { var o = parseInt(m[1], 10); return o >= 16 && o <= 31; }
  return host === "::1" || host.indexOf("fc") === 0 || host.indexOf("fd") === 0;
}

function inList(host, list) {
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (!d) continue;
    if (host === d) return true;
    if (host.length > d.length && host.substring(host.length - d.length - 1) === "." + d) return true;
  }
  return false;
}

function mirrorMatch(host) {
  if (!USE_MIRROR) return false;
  var labels = host.split(".");
  if (labels.length < 2) return false;
  return inList(labels[labels.length - 2], MIRROR);
}

function FindProxyForURL(url, host) {
  host = norm(host);
  if (!host) return "DIRECT";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "DIRECT";
  if (host.length > 6 && host.substring(host.length - 6) === ".local") return "DIRECT";
  if (isPrivate(host)) return "DIRECT";
  if (host.indexOf(".") === -1) return "DIRECT";

  if (inList(host, LEARNED_DIRECT)) return "DIRECT";
  if (inList(host, FORCED)) return SERVER;
  if (!ALL_PROXY) {
    if (USE_IR_TLD && (host === "ir" || host.substring(host.length - 3) === ".ir")) return "DIRECT";
    if (inList(host, BYPASS)) return "DIRECT";
    if (mirrorMatch(host)) return "DIRECT";
  }
  return SERVER;
}
`.trim();
}

function chromeScheme(scheme) {
  switch (scheme) {
    case "socks4":
      return "socks4";
    case "http":
      return "http";
    case "https":
      return "https";
    default:
      return "socks5";
  }
}

function pacScheme(scheme) {
  switch (scheme) {
    case "socks4":
      return "SOCKS";
    case "http":
      return "PROXY";
    case "https":
      return "HTTPS";
    default:
      return "SOCKS5";
  }
}

/**
 * Validate a proxy host. Returns a safe value or the loopback default.
 * Rejects rather than silently mangling: "1.2.3.4:99" must not become "1.2.3.499".
 */
function sanitizeHost(host) {
  const raw = String(host || "").trim().replace(/^https?:\/\//i, "").split("/")[0];
  const candidate = raw.replace(/^\[|\]$/g, "");

  // IPv6 literal (colon-separated hex groups).
  if (candidate.includes(":")) {
    return /^[0-9a-f:]{2,45}$/i.test(candidate) ? candidate : "127.0.0.1";
  }
  // IPv4 or hostname: labels of alphanumerics/hyphens, optional trailing dot.
  if (/^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.?$/i.test(candidate)) {
    return candidate.replace(/\.$/, "");
  }
  return "127.0.0.1";
}