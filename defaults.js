const DEFAULT_IRAN_SITES = [
  // Media / streaming
  "aparat.com",
  "aparat.school",
  "filimo.com",
  "namava.com",
  "telewebion.com",
  "virgool.io",
  "digiato.com",
  "chetor.com",
  "namnak.com",
  // News
  "mehrnews.com",
  "tasnimnews.com",
  "yjc.ir",
  "varzesh3.com",
  // Messengers / social (Iranian)
  "eitaa.com",
  "igap.net",
  "bale.ai",
  "gap.im",
  "soroushapp.com",
  // Marketplaces / shopping / food
  "digikala.com",
  "cafebazaar.ir",
  "divar.ir",
  "sheypoor.com",
  "snapp.ir",
  "snapp.site",
  "snappfood.ir",
  "tapsi.ir",
  "tapsi.cab",
  "alopeyk.com",
  "basalam.com",
  "okala.com",
  "khanoumi.com",
  "torob.com",
  "takhfifan.com",
  "netbarg.com",
  "fidibo.com",
  "sibapp.com",
  "myket.ir",
  // Education
  "maktabkhooneh.org",
  // Payments / bills
  "zarinpal.com",
  "shaparak.ir",
  "ghabzino.com",
  "hamrahcard.ir",
  // Telecom
  "irancell.ir",
  "mci.ir",
  "rightel.ir",
  // Travel
  "mrbilit.com",
  // Maps
  "neshan.org",
  // Other
  "zoomit.ir",
  "picofile.com",
  "dkstatics.com",
  "divarcdn.com"
];

// Brand names that must NOT be mirror-matched to a foreign TLD: they collide
// with unrelated non-Iranian brands or are common words ("mci" is also a US
// telecom, "bale" is the Persian word for "yes", "gap" is the English word).
// These stay listed for their exact TLD but never match _unknown_ TLDs.
const MIRROR_BRAND_EXCLUDED = ["mci", "bale", "gap"];

// Ports commonly used by local proxy clients of Iranian filter-breakers.
// Verified against real installs: v2rayN uses 10808, sing-box/mihomo in various
// desktop wrappers use 10807, Nekoray/Hiddify use 7897, sing-box raw often 2080.
const COMMON_PROXY_PORTS = [
  1080, // v2rayN / Nekoray / generic SOCKS5
  10808, // v2rayN default mixed inbound
  10809, // v2rayN alternate
  7890, // Clash / Mihomo default mixed port
  7891, // Clash SOCKS
  7897, // Nekoray / Hiddify mixed
  10807, // sing-box mixed (observed on this machine)
  7899, // Clash alternate
  2080, // v2rayNG / sing-box
  8888, // many GUI clients
  1087, // Clash Verge
  8118, // privoxy
  8080, // generic
  1081, // older v2rayN
  9050, // Tor SOCKS
  20170 // passwall / luci
];

const LOCAL_PROXY_HOSTS = ["127.0.0.1", "localhost", "::1"];

// Bump whenever detection changes. Shown in the popup and logged by the service
// worker so it is obvious which copy of the code the browser is running.
const BUILD_TAG = "detect-2026-10-13m";

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: "smart",
  proxyScheme: "socks5",
  proxyHost: "127.0.0.1",
  proxyPort: 1080,
  useIrTld: true,
  useDefaultIranSites: true,
  mirrorIranianBrands: true,
  geoIranLookup: false,
  autoFailover: true,
  bypassList: [],
  proxyList: [],
  learned: []
};