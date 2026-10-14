// Proxy detection. Loaded by the service worker via importScripts().
//
// Core idea: "the request succeeded" is NOT proof that the proxy is real.
// The only trustworthy signal is that the traffic left through a DIFFERENT
// public IP than the direct connection. Everything here is built around that.

// IP-echo services that reliably report the CONNECTING client's address.
//
// Deliberately narrow. Testing these on a machine running v2rayN showed that
// ifconfig.me answers 403 and, worse, icanhazip and the Cloudflare trace
// endpoint returned the DIRECT ISP address even when the request was
// explicitly routed through a working tunnel. Trusting such an endpoint would
// make every proxy look like "no tunnel".
const IP_ENDPOINTS = [
  { url: "https://api.ipify.org?format=json", pick: (t) => JSON.parse(t).ip },
  { url: "https://api.ipify.org/", pick: (t) => t.trim() },
  { url: "https://ipinfo.io/json", pick: (t) => JSON.parse(t).ip },
  { url: "https://api.myip.com", pick: (t) => JSON.parse(t).ip }
];

// Preference order. SOCKS5 first: it resolves DNS through the tunnel,
// which avoids leaking the DNS queries of proxied sites.
const SCHEME_ORDER = ["socks5", "http", "socks4", "https"];

const SCHEME_LABEL = {
  socks5: "SOCKS5",
  http: "HTTP",
  socks4: "SOCKS4",
  https: "HTTPS"
};

async function httpGet(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      credentials: "omit",
      signal: controller.signal
    });
    if (!response.ok) throw new Error("http " + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;

function isValidIp(value) {
  return typeof value === "string" && (IPV4.test(value) || IPV6.test(value));
}

/**
 * Read the exit IP, requiring agreement from a second service.
 *
 * A single endpoint can be unreachable, rate-limited, or (as measured on a
 * real setup) report the wrong address. Two independent services that agree
 * are the minimum bar for a measurement we then use to prove a tunnel exists.
 */
async function readEgressIp(timeoutMs = 3000) {
  const answers = [];
  let answeredIndex = -1;
  for (let i = 0; i < IP_ENDPOINTS.length; i++) {
    try {
      const endpoint = IP_ENDPOINTS[i];
      const value = endpoint.pick(await httpGet(endpoint.url, timeoutMs));
      if (isValidIp(value)) {
        answers.push(value.trim());
        answeredIndex = i;
        break;
      }
    } catch (_error) {
      // try the next service
    }
  }

  if (!answers.length) return { ok: false, ip: null };

  // Second opinion from a DIFFERENT service. If it disagrees we cannot trust
  // the first one. (Confirming against the same endpoint proves nothing.)
  for (let i = 0; i < IP_ENDPOINTS.length; i++) {
    if (i === answeredIndex) continue;
    try {
      const endpoint = IP_ENDPOINTS[i];
      const value = endpoint.pick(await httpGet(endpoint.url, timeoutMs));
      if (isValidIp(value) && value.trim() !== answers[0]) {
        return { ok: false, ip: null, conflict: [answers[0], value.trim()] };
      }
      if (isValidIp(value)) return { ok: true, ip: answers[0], confirmed: true };
    } catch (_error) {
      // only one service reachable: accept with lower confidence
    }
  }

  return { ok: true, ip: answers[0], confirmed: false };
}

/**
 * Verify a proxy WITHOUT relying on a direct baseline.
 *
 * Measuring "the direct connection" is unreliable: clearing the browser
 * config does not disable a proxy that the OS provides, so the baseline can
 * silently be the tunnel itself. Every candidate then matches it and every
 * proxy looks like "no tunnel".
 *
 * Instead compare each candidate against every OTHER candidate. If any pair
 * produces different exit IPs, at least one of them is genuinely tunnelled,
 * and the one that differs from the majority is the working proxy.
 */
async function testCandidateStandalone(scheme, host, port) {
  const started = Date.now();
  if (!(await setProxyConfig(scheme, host, port))) {
    return { scheme, host, port, ok: false, verified: false, reason: "config-refused" };
  }
  await new Promise((resolve) => setTimeout(resolve, 120));

  const egress = await readEgressIp();
  const latencyMs = Date.now() - started;

  if (!egress.ok) {
    return {
      scheme,
      host,
      port,
      ok: false,
      verified: false,
      latencyMs,
      reason: egress.conflict ? "ip-conflict" : "unreachable"
    };
  }
  return {
    scheme,
    host,
    port,
    ok: true,
    verified: false, // decided later, by comparing against the other samples
    latencyMs,
    ip: egress.ip
  };
}

/** Pick the sample(s) whose exit IP differs from the most common one. */
/**
 * Decide which samples represent a real tunnel.
 *
 * Most candidates are dead, so the samples that produced an exit IP are the
 * interesting ones. If exactly one answered, it is the tunnel (everything else
 * refused outright). If several answered with differing IPs, the minority is
 * the tunnel and the majority is whatever the OS routes by default. If they
 * all agree, there is no way to tell a tunnel from the normal path.
 */
function pickOutliers(samples) {
  const usable = samples.filter((s) => s.ok && s.ip);

  if (usable.length === 0) return { winners: [], majority: null, unanimous: null };
  if (usable.length === 1) return { winners: usable, majority: null, unanimous: null };

  const counts = new Map();
  for (const s of usable) counts.set(s.ip, (counts.get(s.ip) || 0) + 1);

  let majorityIp = null;
  let majorityCount = -1;
  for (const [ip, count] of counts) {
    if (count > majorityCount) {
      majorityIp = ip;
      majorityCount = count;
    }
  }

  if (majorityCount === usable.length) {
    return { winners: [], majority: majorityIp, unanimous: majorityIp };
  }
  return {
    winners: usable.filter((s) => s.ip !== majorityIp),
    majority: majorityIp,
    unanimous: null
  };
}
async function captureProxyState() {
  try {
    const result = await chrome.proxy.settings.get({ incognito: false });
    return { level: result?.level || "system", value: result?.value || null };
  } catch (_error) {
    return null;
  }
}

async function restoreProxyState(snapshot) {
  if (!snapshot || !snapshot.value) {
    await clearProxyConfig();
    return;
  }
  try {
    await chrome.proxy.settings.set({ value: snapshot.value, scope: "regular" });
  } catch (_error) {
    await clearProxyConfig();
  }
}

/**
 * Measure the exit IP of the CURRENT configuration.
 *
 * Pass mode:"direct" to genuinely measure the direct connection. Note that
 * clearing the config is NOT the same as measuring direct: on systems where a
 * filter-breaker also owns a system proxy or a VPN, "cleared" just means
 * "whatever the OS now decides", which may still be a tunnel.
 */

/**
 * Who owns the proxy setting right now?
 *
 * "controlled_by_other_extensions" is the silent killer: every attempt to set
 * a proxy fails, so all candidates look dead and detection always reports
 * "no proxy". Knowing this lets us say so instead of guessing.
 */
async function proxyControlLevel() {
  try {
    const result = await chrome.proxy.settings.get({ incognito: false });
    return result?.level || "system";
  } catch (_error) {
    return "unknown";
  }
}

let lastConfigError = null;

/**
 * Install a proxy configuration. Returns false if Chrome refused it
 * (another extension already controls the proxy).
 */
async function setProxyConfig(scheme, host, port) {
  try {
    await chrome.proxy.settings.set({
      value: {
        mode: "fixed_servers",
        rules: { singleProxy: { scheme, host, port } }
      },
      scope: "regular"
    });
    lastConfigError = null;
    return true;
  } catch (error) {
    lastConfigError = error?.message || String(error);
    return false;
  }
}

async function clearProxyConfig() {
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Read the proxy configuration Chrome is ALREADY using.
 *
 * This is the cheapest and most reliable source there is: when the user
 * already has a system proxy (GNOME "manual" mode, v2rayN, Clash, ...), Chrome
 * picked it up at startup and we can just read it instead of scanning.
 * Returns {mode, servers[], source} or null.
 */
async function readEffectiveProxyConfig() {
  try {
    const result = await chrome.proxy.settings.get({ incognito: false });
    const value = result?.value;
    if (!value || value.mode === "direct" || value.mode === "system") return null;

    const servers = [];
    const rules = value.rules || {};

    for (const key of ["singleProxy", "proxyForHttp", "proxyForSsl", "proxyForFtp"]) {
      const server = rules[key];
      if (server?.host && server?.port) servers.push(normalizeServer(server, key));
    }
    for (const server of rules.fallbackProxy || []) {
      if (server?.host && server?.port) servers.push(normalizeServer(server, "fallback"));
    }
    for (const server of rules.proxies || []) {
      if (server?.host && server?.port) servers.push(normalizeServer(server, "list"));
    }

    return { mode: value.mode, servers, pacScript: value.pacScript?.data || null };
  } catch (_error) {
    return null;
  }
}

const SCHEME_FROM_CHROME = { http: "http", https: "https", socks: "socks5", socks4: "socks4", socks5: "socks5" };

function normalizeServer(server, kind) {
  const scheme = SCHEME_FROM_CHROME[server.scheme] || server.scheme || "http";
  return {
    scheme,
    host: server.host,
    port: Number(server.port),
    source: kind === "list" ? "chrome-config" : "chrome-" + kind
  };
}

/** Turn a PAC script into (host, port) candidates by parsing its PROXY lines. */
function parsePacServers(pacData) {
  if (!pacData || typeof pacData !== "string") return [];
  const found = [];
  const pattern = /\b(PROXY|PROXY\s+[^;\s]+|SOCKS5?|SOCKS|https?)\s+([^\s;"']+):(\d{2,5})/gi;
  let match;
  while ((match = pattern.exec(pacData)) !== null) {
    const token = match[1].trim().toUpperCase();
    const address = match[2];
    const port = Number(match[3]);
    if (!port || port < 1 || port > 65535) continue;
    const scheme = token === "SOCKS5" ? "socks5" : token === "SOCKS" || token === "SOCKS4" ? "socks4" : token === "HTTPS" ? "https" : "http";
    // Keep IPs and localhost intact; only trim the last label off real hostnames.
    const bare = address.replace(/^\[|\]$/g, "");
    const host = /^[\d.]+$/.test(bare) || bare === "localhost" ? bare : bare.split(".").slice(-2).join(".");
    found.push({ scheme, host, port, source: "pac-script" });
  }
  return found;
}

/**
 * Test one scheme against one port.
 *
 * ok       - a request completed
 * verified - the egress IP differs from the direct IP, i.e. traffic really
 *            left through the tunnel. Without this we cannot tell a working
 *            proxy from a request that silently ignored the proxy.
 */


/**
 * Full scan.
 * Returns every scheme that actually works on the winning port, so a mixed
 * port (Clash etc.) is reported honestly instead of guessing one scheme.
 */
async function detectProxy(settings, onProgress) {
  const report = (step) => {
    try {
      onProgress?.(step);
    } catch (_error) {
      // progress reporting is best-effort
    }
  };

  const snapshot = await captureProxyState();

  try {
    // If another extension owns the proxy setting, every set() below will throw
    // and every candidate looks dead. Say so instead of reporting "no proxy".
    const level = await proxyControlLevel();
    if (level === "controlled_by_other_extensions") {
      report({ phase: "done" });
      return {
        found: false,
        reason: "other-extension",
        message:
          "یک افزونهٔ دیگر تنظیمات پروکسی مرورگر را در کنترل دارد. آن را غیرفعال کنید تا تشخیص کار کند."
      };
    }

    // ---- Layer 0: ask Chrome what it is already using --------------------
    report({ phase: "reading-config", message: "خواندن تنظیمات فعلی مرورگر..." });

    const effective = await readEffectiveProxyConfig();
    const known = [
      ...(effective?.servers || []),
      ...parsePacServers(effective?.pacScript)
    ].filter((server) => server && isLocalHostName(server.host) && server.port > 0);

    // Sample every plausible local endpoint and compare the samples with EACH
    // OTHER. This deliberately avoids measuring a "direct" connection: clearing
    // the browser config does not disable a proxy supplied by the OS, so a
    // direct measurement can silently be the tunnel itself. Comparing candidates
    // against each other needs no such assumption.
    const targets = [];
    const addTarget = (scheme, host, port, source) => {
      const value = Number(port);
      if (!Number.isInteger(value) || value < 1 || value > 65535) return;
      if (targets.some((t) => t.port === value && t.host === host)) return;
      targets.push({ scheme, host, port, source });
    };

    for (const server of known) addTarget(server.scheme, server.host, server.port, "chrome-config");
    const scanPorts = collectPorts(settings);
    for (const port of scanPorts) {
      addTarget(settings.proxyScheme, sanitizeHost(settings.proxyHost), port, "scan");
    }

    report({ phase: "scan", total: targets.length });

    const samples = [];
    const diagnostics = [];
    const scanStart = Date.now();
    // Hard budget: a service worker that runs too long gets terminated, which
    // makes the popup button appear to hang forever. Stop and report with what
    // we have instead.
    const SCAN_BUDGET_MS = 60000;
    for (const target of targets) {
      if (Date.now() - scanStart > SCAN_BUDGET_MS) break;
      report({ phase: "scan", port: target.port, tested: samples.length, total: targets.length });

      const order = [target.scheme, ...SCHEME_ORDER.filter((s) => s !== target.scheme)];
      for (const scheme of order) {
        const result = await testCandidateStandalone(scheme, target.host, target.port);
        diagnostics.push({
          scheme,
          port: result.port,
          ok: result.ok,
          ip: result.ip || null,
          reason: result.reason || null,
          ms: result.latencyMs || null
        });
        samples.push(result);
        if (result.ok) break;
      }
    }

    const { winners, majority } = pickOutliers(samples);

    const trim = (s) => ({ found: s.found, reason: s.reason, message: s.message, diagnostics });

    if (!winners.length) {
      const reachable = samples.filter((s) => s.ok);
      if (!reachable.length) {
        report({ phase: "done" });
        return trim({
          found: false,
          inconclusive: true,
          reason: "no-internet",
          message: lastConfigError
            ? "تنظیم پروکسی برای آزمایش ممکن نشد: " + lastConfigError
            : "هیچ سرویس IP پاسخ نداد؛ نتیجه قابل اعتماد نیست."
        });
      }
      report({ phase: "done" });
      return trim({
        found: false,
        reason: "no-proxy",
        allSameIp: majority,
        // Several endpoints answered with the same address. That usually means
        // the browser never left the tunnel, so the OS already routes through a
        // proxy and there is nothing here to detect.
        message:
          "پروکسی فعالی که متفاوت باشد پیدا نشد. اگر پروکسی سیستم روشن است، مرورگر از آن استفاده می‌کند و نیازی به تنظیم دستی نیست."
      });
    }

    const winner = winners.reduce((a, b) => (a.latencyMs <= b.latencyMs ? a : b));
    const supported = await testAllSchemes(winner, { ok: false, ip: majority });

    report({ phase: "done" });
    const foundResult = {
      found: true,
      baselineIp: majority || null,
      tunnelIp: winner.ip,
      proxyScheme: winner.scheme,
      proxyHost: winner.host,
      proxyPort: winner.port,
      latencyMs: winner.latencyMs,
      mixedPort: supported.length > 1,
      supportedSchemes: supported,
      recommendation: buildRecommendation(winner, supported)
    };
    foundResult.diagnostics = diagnostics;
    return foundResult;
  } finally {
    // Put the browser back exactly as it was before the scan.
    await restoreProxyState(snapshot);
  }
}

function isLocalHostName(host) {
  const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  return (
    value === "localhost" ||
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "0.0.0.0" ||
    /^127\./.test(value) ||
    /^192\.168\./.test(value) ||
    /^10\./.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(value)
  );
}

/** Confirm the proxy Chrome already had, instead of scanning blindly. */




function collectPorts(settings) {
  const ordered = [];
  const add = (port) => {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) return;
    if (!ordered.includes(value)) ordered.push(value);
  };

  add(settings.proxyPort);
  for (const port of COMMON_PROXY_PORTS) add(port);
  return ordered;
}



/** Report every scheme that works on the winning port, best first. */
/**
 * Report every scheme that works on the winning port.
 * A scheme counts when it routes through the tunnel, i.e. it produces the
 * same exit IP as the confirmed winner.
 */
async function testAllSchemes(winner, baseline) {
  const schemes = [winner.scheme];
  for (const scheme of SCHEME_ORDER) {
    if (scheme === winner.scheme) continue;
    const result = await testCandidateStandalone(scheme, winner.host, winner.port);
    if (result.ok && result.ip === winner.ip) schemes.push(scheme);
  }
  return schemes;
}

function buildRecommendation(winner, schemes) {
  const labels = schemes.map((scheme) => SCHEME_LABEL[scheme] || scheme);
  const notes = [];

  if (winner.scheme !== "socks5" && schemes.includes("socks5")) {
    notes.push("SOCKS5 هم روی این پورت کار می‌کند و توصیه می‌شود؛ DNS از داخل تونل حل می‌شود.");
  }
  if (schemes.length === 1) {
    notes.push("فقط یک نوع پروکسی روی این پورت پاسخ داد.");
  } else {
    notes.push("این پورت چندتایی است و چند نوع پروکسی را می‌پذیرد.");
  }
  notes.push(`تأخیر اندازه‌گیری‌شده: ${winner.latencyMs} میلی‌ثانیه.`);

  return {
    scheme: winner.scheme,
    label: SCHEME_LABEL[winner.scheme] || winner.scheme,
    host: winner.host,
    port: winner.port,
    supported: labels,
    notes
  };
}