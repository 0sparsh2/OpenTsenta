// Job locations come in thousands of spellings ("San Francisco", "SF / NYC", "Remote - US", "CHENNAI, TAMIL NADU,
// India", "Berlin, BE, Germany", "Richardson, TX, US, 75080"). placesOf() turns one into the places a person would
// filter by: the city, its metro area, the state or province, the country, and remote (within a country, or anywhere).

export type PlaceKind = "remote" | "metro" | "city" | "region" | "country";
export interface Place {
  kind: PlaceKind;
  /** Stable id: "us", "us-ca", "us-ca-san-francisco", "metro-us-sfbay", "remote-us", "remote-any". */
  key: string;
  label: string;
}

/** Bump when parsing changes, so stored places are recomputed. */
export const PLACES_VERSION = 3;

const COUNTRIES: Record<string, string> = {
  US: "United States", CA: "Canada", MX: "Mexico", BR: "Brazil", AR: "Argentina", CL: "Chile", CO: "Colombia", PE: "Peru", UY: "Uruguay", CR: "Costa Rica",
  GB: "United Kingdom", IE: "Ireland", DE: "Germany", FR: "France", NL: "Netherlands", BE: "Belgium", LU: "Luxembourg", CH: "Switzerland", AT: "Austria",
  ES: "Spain", PT: "Portugal", IT: "Italy", GR: "Greece", SE: "Sweden", NO: "Norway", DK: "Denmark", FI: "Finland", IS: "Iceland", PL: "Poland",
  CZ: "Czechia", SK: "Slovakia", HU: "Hungary", RO: "Romania", BG: "Bulgaria", HR: "Croatia", RS: "Serbia", SI: "Slovenia", UA: "Ukraine", EE: "Estonia",
  LV: "Latvia", LT: "Lithuania", TR: "Turkey", IL: "Israel", AE: "United Arab Emirates", SA: "Saudi Arabia", QA: "Qatar", EG: "Egypt", MA: "Morocco",
  ZA: "South Africa", NG: "Nigeria", KE: "Kenya", IN: "India", PK: "Pakistan", BD: "Bangladesh", LK: "Sri Lanka", NP: "Nepal", SG: "Singapore",
  MY: "Malaysia", TH: "Thailand", VN: "Vietnam", PH: "Philippines", ID: "Indonesia", CN: "China", HK: "Hong Kong", TW: "Taiwan", KR: "South Korea",
  JP: "Japan", AU: "Australia", NZ: "New Zealand",
};
const COUNTRY_ALIASES: Record<string, string> = {
  usa: "US", "u s": "US", "u s a": "US", "united states of america": "US", america: "US", "us remote": "US",
  uk: "GB", "u k": "GB", "great britain": "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB",
  deutschland: "DE", holland: "NL", "the netherlands": "NL", "czech republic": "CZ", korea: "KR", "republic of korea": "KR", uae: "AE",
  "hong kong sar": "HK", "türkiye": "TR", turkiye: "TR", "viet nam": "VN",
};

const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska",
  NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};
const CA_PROVINCES: Record<string, string> = {
  ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba", SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick",
  NL: "Newfoundland and Labrador", PE: "Prince Edward Island", YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut",
};

/** Cities often written without a state or country: city → [region code, country]. */
const GAZETTEER: Record<string, [string, string]> = {
  "san francisco": ["CA", "US"], "palo alto": ["CA", "US"], "mountain view": ["CA", "US"], sunnyvale: ["CA", "US"], "menlo park": ["CA", "US"],
  "redwood city": ["CA", "US"], "san mateo": ["CA", "US"], "foster city": ["CA", "US"], "san jose": ["CA", "US"], "santa clara": ["CA", "US"],
  cupertino: ["CA", "US"], oakland: ["CA", "US"], berkeley: ["CA", "US"], emeryville: ["CA", "US"], "south san francisco": ["CA", "US"],
  "los angeles": ["CA", "US"], "santa monica": ["CA", "US"], "culver city": ["CA", "US"], "el segundo": ["CA", "US"], hawthorne: ["CA", "US"],
  irvine: ["CA", "US"], "costa mesa": ["CA", "US"], "redondo beach": ["CA", "US"], "long beach": ["CA", "US"], pasadena: ["CA", "US"],
  "san diego": ["CA", "US"], sacramento: ["CA", "US"], "new york": ["NY", "US"], brooklyn: ["NY", "US"], "jersey city": ["NJ", "US"],
  hoboken: ["NJ", "US"], seattle: ["WA", "US"], bellevue: ["WA", "US"], redmond: ["WA", "US"], kirkland: ["WA", "US"], boston: ["MA", "US"],
  somerville: ["MA", "US"], waltham: ["MA", "US"], chicago: ["IL", "US"], austin: ["TX", "US"], dallas: ["TX", "US"], houston: ["TX", "US"],
  "san antonio": ["TX", "US"], starbase: ["TX", "US"], bastrop: ["TX", "US"], denver: ["CO", "US"], boulder: ["CO", "US"], atlanta: ["GA", "US"],
  miami: ["FL", "US"], phoenix: ["AZ", "US"], tempe: ["AZ", "US"], scottsdale: ["AZ", "US"], "salt lake city": ["UT", "US"], lehi: ["UT", "US"],
  portland: ["OR", "US"], pittsburgh: ["PA", "US"], philadelphia: ["PA", "US"], minneapolis: ["MN", "US"], detroit: ["MI", "US"],
  "ann arbor": ["MI", "US"], raleigh: ["NC", "US"], durham: ["NC", "US"], nashville: ["TN", "US"], columbus: ["OH", "US"], reston: ["VA", "US"],
  arlington: ["VA", "US"], mclean: ["VA", "US"], herndon: ["VA", "US"], bethesda: ["MD", "US"], "washington": ["DC", "US"],
  toronto: ["ON", "CA"], vancouver: ["BC", "CA"], montreal: ["QC", "CA"], waterloo: ["ON", "CA"], ottawa: ["ON", "CA"], calgary: ["AB", "CA"],
  london: ["", "GB"], manchester: ["", "GB"], edinburgh: ["", "GB"], dublin: ["", "IE"], berlin: ["", "DE"], munich: ["", "DE"], hamburg: ["", "DE"],
  paris: ["", "FR"], amsterdam: ["", "NL"], zurich: ["", "CH"], madrid: ["", "ES"], barcelona: ["", "ES"], lisbon: ["", "PT"], milan: ["", "IT"],
  stockholm: ["", "SE"], copenhagen: ["", "DK"], oslo: ["", "NO"], helsinki: ["", "FI"], warsaw: ["", "PL"], krakow: ["", "PL"], prague: ["", "CZ"],
  "tel aviv": ["", "IL"], dubai: ["", "AE"], bengaluru: ["", "IN"], hyderabad: ["", "IN"], pune: ["", "IN"], chennai: ["", "IN"], mumbai: ["", "IN"],
  "new delhi": ["", "IN"], delhi: ["", "IN"], gurugram: ["", "IN"], noida: ["", "IN"], singapore: ["", "SG"], tokyo: ["", "JP"], seoul: ["", "KR"],
  "hong kong": ["", "HK"], taipei: ["", "TW"], shanghai: ["", "CN"], beijing: ["", "CN"], sydney: ["", "AU"], melbourne: ["", "AU"],
  "sao paulo": ["", "BR"], "mexico city": ["", "MX"], "buenos aires": ["", "AR"], bogota: ["", "CO"],
};
const CITY_ALIASES: Record<string, string> = {
  nyc: "new york", "new york city": "new york", manhattan: "new york", sf: "san francisco", "san francisco bay area": "san francisco",
  "bay area": "san francisco", "sf bay area": "san francisco", "silicon valley": "san francisco", "greater new york": "new york",
  bangalore: "bengaluru", bombay: "mumbai", gurgaon: "gurugram", "washington dc": "washington", "washington d c": "washington",
  "st louis": "saint louis", montréal: "montreal", "são paulo": "sao paulo", "zürich": "zurich", "münchen": "munich", "kraków": "krakow",
  "bogotá": "bogota", "tel aviv yafo": "tel aviv", "tel aviv-yafo": "tel aviv", "ciudad de mexico": "mexico city",
};

/** Metro areas: id → [name, member city keys]. */
const METROS: Record<string, [string, string[]]> = {
  "us-sfbay": ["San Francisco Bay Area", ["us-ca-san-francisco", "us-ca-oakland", "us-ca-berkeley", "us-ca-emeryville", "us-ca-san-jose", "us-ca-palo-alto", "us-ca-mountain-view", "us-ca-sunnyvale", "us-ca-menlo-park", "us-ca-redwood-city", "us-ca-san-mateo", "us-ca-foster-city", "us-ca-santa-clara", "us-ca-cupertino", "us-ca-fremont", "us-ca-south-san-francisco", "us-ca-burlingame", "us-ca-san-bruno", "us-ca-milpitas", "us-ca-los-gatos", "us-ca-campbell", "us-ca-pleasanton", "us-ca-walnut-creek", "us-ca-san-carlos", "us-ca-belmont", "us-ca-los-altos", "us-ca-alameda", "us-ca-hayward", "us-ca-livermore", "us-ca-san-ramon", "us-ca-brisbane", "us-ca-newark"]],
  "us-nyc": ["New York City area", ["us-ny-new-york", "us-ny-brooklyn", "us-ny-long-island-city", "us-ny-queens", "us-nj-jersey-city", "us-nj-hoboken", "us-nj-newark", "us-ct-stamford", "us-ny-white-plains"]],
  "us-seattle": ["Seattle area", ["us-wa-seattle", "us-wa-bellevue", "us-wa-redmond", "us-wa-kirkland", "us-wa-bothell", "us-wa-everett", "us-wa-renton", "us-wa-tacoma"]],
  "us-la": ["Greater Los Angeles", ["us-ca-los-angeles", "us-ca-santa-monica", "us-ca-culver-city", "us-ca-el-segundo", "us-ca-hawthorne", "us-ca-pasadena", "us-ca-burbank", "us-ca-long-beach", "us-ca-irvine", "us-ca-costa-mesa", "us-ca-torrance", "us-ca-redondo-beach", "us-ca-playa-vista", "us-ca-glendale", "us-ca-newport-beach", "us-ca-santa-ana", "us-ca-anaheim", "us-ca-venice", "us-ca-marina-del-rey", "us-ca-long-beach"]],
  "us-boston": ["Greater Boston", ["us-ma-boston", "us-ma-cambridge", "us-ma-somerville", "us-ma-waltham", "us-ma-burlington", "us-ma-lexington", "us-ma-bedford", "us-ma-woburn", "us-ma-watertown", "us-ma-needham", "us-ma-newton", "us-ma-quincy", "us-ma-framingham", "us-ma-andover"]],
  "us-dc": ["Washington, DC area", ["us-dc-washington", "us-va-arlington", "us-va-alexandria", "us-va-reston", "us-va-herndon", "us-va-mclean", "us-va-tysons", "us-va-chantilly", "us-va-fairfax", "us-va-sterling", "us-md-bethesda", "us-md-rockville", "us-md-gaithersburg", "us-md-columbia", "us-md-annapolis-junction", "us-md-fort-meade", "us-md-silver-spring"]],
  "us-austin": ["Austin area", ["us-tx-austin", "us-tx-round-rock", "us-tx-cedar-park"]],
  "us-dfw": ["Dallas–Fort Worth", ["us-tx-dallas", "us-tx-fort-worth", "us-tx-plano", "us-tx-irving", "us-tx-richardson", "us-tx-frisco", "us-tx-addison", "us-tx-arlington"]],
  "us-houston": ["Houston area", ["us-tx-houston", "us-tx-the-woodlands", "us-tx-sugar-land"]],
  "us-chicago": ["Chicago area", ["us-il-chicago", "us-il-evanston", "us-il-schaumburg", "us-il-naperville"]],
  "us-denver": ["Denver–Boulder", ["us-co-denver", "us-co-boulder", "us-co-broomfield", "us-co-aurora", "us-co-englewood", "us-co-louisville", "us-co-golden"]],
  "us-atlanta": ["Atlanta area", ["us-ga-atlanta", "us-ga-alpharetta", "us-ga-marietta"]],
  "us-sandiego": ["San Diego area", ["us-ca-san-diego", "us-ca-carlsbad", "us-ca-la-jolla"]],
  "us-phoenix": ["Phoenix area", ["us-az-phoenix", "us-az-tempe", "us-az-scottsdale", "us-az-chandler", "us-az-mesa"]],
  "us-triangle": ["Raleigh–Durham", ["us-nc-raleigh", "us-nc-durham", "us-nc-cary", "us-nc-morrisville", "us-nc-chapel-hill", "us-nc-research-triangle-park"]],
  "us-saltlake": ["Salt Lake City area", ["us-ut-salt-lake-city", "us-ut-lehi", "us-ut-draper", "us-ut-south-jordan", "us-ut-provo", "us-ut-sandy"]],
  "us-portland": ["Portland area", ["us-or-portland", "us-or-beaverton", "us-or-hillsboro"]],
  "us-philly": ["Philadelphia area", ["us-pa-philadelphia", "us-pa-king-of-prussia", "us-pa-conshohocken"]],
  "us-twincities": ["Minneapolis–St. Paul", ["us-mn-minneapolis", "us-mn-saint-paul"]],
  "in-ncr": ["Delhi NCR", ["in-new-delhi", "in-delhi", "in-gurugram", "in-noida"]],
  "il-telaviv": ["Tel Aviv area", ["il-tel-aviv", "il-herzliya", "il-ramat-gan"]],
  "ca-toronto": ["Greater Toronto", ["ca-on-toronto", "ca-on-mississauga", "ca-on-markham"]],
};
const METRO_OF = new Map<string, string>();
for (const [id, [, members]] of Object.entries(METROS)) for (const m of members) METRO_OF.set(m, id);

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 -]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const slug = (s: string) => norm(s).replace(/ /g, "-");
const titleCase = (s: string) => (s === s.toUpperCase() && s.length > 3 ? s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase()) : s);

const countryOf = (s: string): string | undefined => {
  const n = norm(s);
  if (!n) return undefined;
  if (COUNTRY_ALIASES[n]) return COUNTRY_ALIASES[n];
  const up = s.trim().toUpperCase();
  // Two-letter codes only when unambiguous (not a US state or Canadian province code).
  if (/^[A-Z]{2}$/.test(up) && COUNTRIES[up] && !US_STATES[up] && !CA_PROVINCES[up]) return up;
  if (up === "US" || up === "USA") return "US";
  return Object.entries(COUNTRIES).find(([, name]) => norm(name) === n)?.[0];
};
const usState = (s: string) => {
  const up = s.trim().toUpperCase().replace(/\./g, "");
  if (US_STATES[up]) return up;
  const n = norm(s);
  return Object.entries(US_STATES).find(([, name]) => norm(name) === n)?.[0];
};
const caProvince = (s: string) => {
  const up = s.trim().toUpperCase();
  if (CA_PROVINCES[up]) return up;
  const n = norm(s);
  return Object.entries(CA_PROVINCES).find(([, name]) => norm(name) === n)?.[0];
};

const NOT_A_PLACE = /^(\d+ )?(locations?|multiple locations|various( locations)?|flexible|hybrid|on-?site|in office|office|tbd|n\/?a|global|worldwide|anywhere|remote|distributed|home based)$/i;

/** One location (not a list) → places. */
function parseOne(raw: string): Place[] {
  let s = raw
    .replace(/\b\d{5}(-\d{4})?\b/g, "") // US ZIP
    .replace(/\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/g, "") // Canadian postal code
    .replace(/\s+/g, " ")
    .trim();
  let remote = false;
  // "Canada - Remote (ON, AB, BC, or NS Only)", "Germany (Remote)": the place, remote.
  const tail = s.match(/^(.+?)\s*[-–—,]?\s*\(?\bremote\b.*$/i);
  if (tail && !/^remote\b/i.test(s) && countryOf(tail[1])) {
    remote = true;
    s = tail[1];
  }
  // Asides in parentheses ("(HQ)", "(ON, AB, or BC only)") aren't part of the place.
  s = s.replace(/\s*\((?!remote)[^)]*\)\s*/gi, " ").replace(/\(\s*$/, "").trim();
  // "Remote - US", "Remote (Canada)", "US Remote", "Remote, United States", "Remote in Germany", "(Remote)"
  const rm = s.match(/^(?:fully |100% )?remote\b\s*(?:[-–—:,(]|\bin\b|\bwithin\b|\bbased in\b)?\s*(.*?)\)?$/i) ?? s.match(/^(.*?)[\s,-]*\(?\b(?:remote|work from home|wfh)\b\)?$/i);
  if (rm) {
    remote = true;
    s = (rm[1] ?? "").replace(/^[-–—:,(\s]+|[-–—:,)\s]+$/g, "").trim();
  }
  s = s
    .replace(/\s*\((hybrid|on-?site|in office)\)\s*$/i, "")
    .replace(/^(hybrid|on-?site|in[- ]office)\s*[-–—:,]\s*/i, "")
    .trim();
  const places: Place[] = [];
  const add = (p: Place) => places.some((x) => x.key === p.key) || places.push(p);

  if (!s || NOT_A_PLACE.test(s)) {
    if (remote) add({ kind: "remote", key: "remote-any", label: "Remote (anywhere)" });
    return places;
  }

  // "San Mateo, CA United States" → split a trailing country off a part.
  let parts = s.split(/\s*,\s*/).flatMap((p) => {
    const m = p.match(/^(.+?)\s+(United States|USA|United Kingdom|UK|Canada|India|Germany)$/i);
    return m && (usState(m[1]) || caProvince(m[1])) ? [m[1], m[2]] : [p];
  });
  parts = parts
    .map((p) =>
      titleCase(p.trim())
        .replace(/^co\.?\s+(?=\p{Lu})/iu, "") // "Co. Dublin" → Dublin
        .replace(/^ft\.?\s+/i, "Fort "),
    )
    .filter(Boolean);

  // "New York" on its own is the city, not the state.
  if (parts.length === 1 && /^new york( city)?$/i.test(parts[0])) parts = ["New York", "NY"];

  let country: string | undefined;
  let region: string | undefined; // US state or Canadian province code
  let regionName: string | undefined; // other countries' regions, as written
  let city: string | undefined;

  // Country: the last part that names one.
  for (let i = parts.length - 1; i >= 0 && !country; i--) {
    const c = countryOf(parts[i]);
    if (c && (i > 0 || parts.length === 1)) {
      country = c;
      parts.splice(i, 1);
    } else if (c && parts.length === 1) country = c;
  }
  // "Quebec, CA": after a province, CA is Canada.
  if (!country && parts.length >= 2 && parts[parts.length - 1].toUpperCase() === "CA" && caProvince(parts[parts.length - 2])) {
    country = "CA";
    parts.pop();
  }
  // Region: a US state or Canadian province among the remaining parts (after the city).
  for (let i = parts.length - 1; i >= (parts.length > 1 ? 1 : 0); i--) {
    const st = country === "CA" ? undefined : usState(parts[i]);
    const pv = country === "US" ? undefined : caProvince(parts[i]);
    if (st && (!country || country === "US")) {
      region = st;
      country = "US";
      parts.splice(i, 1);
      break;
    }
    if (pv && (!country || country === "CA")) {
      region = pv;
      country = "CA";
      parts.splice(i, 1);
      break;
    }
  }
  if (parts.length) {
    const first = parts[0];
    // A bare region or country ("California", "Texas", "Ontario") isn't a city.
    if (!region && parts.length === 1 && usState(first) && first.length > 2) {
      region = usState(first);
      country = "US";
    } else if (!region && parts.length === 1 && caProvince(first) && first.length > 2) {
      region = caProvince(first);
      country = "CA";
    } else if (!(parts.length === 1 && countryOf(first))) {
      city = first;
      if (parts.length > 1 && country && country !== "US" && country !== "CA" && parts[1].length > 3) regionName = parts[1];
    }
  }
  if (city) {
    const known = CITY_ALIASES[norm(city)] ?? norm(city);
    const g = GAZETTEER[known];
    if (g && (!country || country === g[1]) && (!region || !g[0] || region === g[0])) {
      country ??= g[1];
      if (g[0]) region ??= g[0];
      city = titleCase(known.replace(/(^|[\s-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase()));
      if (known === "washington") city = "Washington";
    }
  }

  const cc = country?.toLowerCase();
  if (city) {
    const key = [cc ?? "xx", region?.toLowerCase(), slug(CITY_ALIASES[norm(city)] ?? city)].filter(Boolean).join("-");
    const label = region ? `${city}, ${region}` : country ? `${city}, ${COUNTRIES[country]}` : city;
    add({ kind: "city", key, label });
    const metro = METRO_OF.get(key);
    if (metro) add({ kind: "metro", key: `metro-${metro}`, label: METROS[metro][0] });
  }
  if (region && cc) add({ kind: "region", key: `${cc}-${region.toLowerCase()}`, label: country === "US" ? US_STATES[region] : CA_PROVINCES[region] });
  else if (regionName && cc) add({ kind: "region", key: `${cc}-${slug(regionName)}`, label: `${regionName}, ${COUNTRIES[country!]}` });
  if (country) add({ kind: "country", key: cc!, label: COUNTRIES[country] });
  if (remote) add(country ? { kind: "remote", key: `remote-${cc}`, label: `Remote (${COUNTRIES[country]})` } : { kind: "remote", key: "remote-any", label: "Remote (anywhere)" });
  return places;
}

/** Every place a job's location string names (several for "SF / NYC / Remote - US"). */
export function placesOf(location: string, workplace?: string): Place[] {
  // Separators inside parentheses ("Remote (ON, AB, or BC only)") don't split the list.
  let depth = 0;
  const masked = (location ?? "")
    .replace(/\b(and|or)\s+\d+\s+more\b.*$/i, "")
    // "Remote (United States | Canada)", "Remote (ON, AB, or BC only)" → one remote place each.
    .replace(/\bremote\s*\(([^)]+)\)/gi, (_m, inner: string) =>
      inner
        .split(/\s*(?:\||\/|,|;|\bor\b|&)\s*/i)
        .map((x) => x.replace(/\s+only$/i, "").trim())
        .filter(Boolean)
        .map((x) => `Remote - ${x}`)
        .join(" | "),
    ).replace(/[()|/;]|\bor\b/gi, (ch) => {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth) return ch === "|" ? "\u0001" : ch === "/" ? "\u0002" : ch === ";" ? "\u0003" : "\u0004";
    return ch;
  });
  const parts = masked
    .split(/\s*(?:\||\/|;|\n|•|·| or |\bor\b(?= [A-Z])| & (?=[A-Z][a-z]+,)|, (?=remote\b))\s*/i)
    .map((p) => p.replace(/\u0001/g, "|").replace(/\u0002/g, "/").replace(/\u0003/g, ";").replace(/\u0004/g, "or").trim())
    .filter(Boolean);
  const out: Place[] = [];
  for (const p of parts.length ? parts : [""]) for (const pl of parseOne(p)) if (!out.some((x) => x.key === pl.key)) out.push(pl);
  // A remote job whose location names only a country (or nothing): remote within it.
  if (workplace === "remote" && !out.some((p) => p.kind === "remote")) {
    const countries = out.filter((p) => p.kind === "country");
    if (countries.length) for (const c of countries) out.push({ kind: "remote", key: `remote-${c.key}`, label: `Remote (${c.label})` });
    else out.push({ kind: "remote", key: "remote-any", label: "Remote (anywhere)" });
  }
  return out;
}

export const KIND_ORDER: PlaceKind[] = ["remote", "metro", "city", "region", "country"];
