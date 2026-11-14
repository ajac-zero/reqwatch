export interface ParsedLocation {
  city?: string;
  region?: string;
  /** ISO 3166-1 alpha-2, or null when it cannot be determined from the string. Never guessed. */
  country: string | null;
  remote: boolean;
}

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

const CA_PROVINCES: Record<string, string> = {
  ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba",
  SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  PE: "Prince Edward Island",
};

const US_STATE_BY_NAME = new Map(Object.entries(US_STATES).map(([k, v]) => [v.toLowerCase(), k]));

/** Abbreviations that are also country codes or too ambiguous outside "City, ST" shape. */
const AMBIGUOUS_STATE = new Set(["DE"]);

const COUNTRIES: Record<string, string> = {
  US: "us", USA: "us", "U.S.": "us", "U.S.A.": "us", "UNITED STATES": "us", "UNITED STATES OF AMERICA": "us",
  CANADA: "ca", UK: "gb", "U.K.": "gb", "UNITED KINGDOM": "gb", ENGLAND: "gb", SCOTLAND: "gb", WALES: "gb",
  "NORTHERN IRELAND": "gb", "GREAT BRITAIN": "gb", IRELAND: "ie", GERMANY: "de", DEUTSCHLAND: "de",
  FRANCE: "fr", NETHERLANDS: "nl", "THE NETHERLANDS": "nl", SPAIN: "es", ITALY: "it", POLAND: "pl",
  PORTUGAL: "pt", SWEDEN: "se", NORWAY: "no", DENMARK: "dk", FINLAND: "fi", SWITZERLAND: "ch",
  AUSTRIA: "at", BELGIUM: "be", INDIA: "in", SINGAPORE: "sg", JAPAN: "jp", CHINA: "cn",
  AUSTRALIA: "au", "NEW ZEALAND": "nz", BRAZIL: "br", MEXICO: "mx", ISRAEL: "il", ARGENTINA: "ar",
  COLOMBIA: "co", UAE: "ae", "UNITED ARAB EMIRATES": "ae", "SOUTH KOREA": "kr", KOREA: "kr",
  TAIWAN: "tw", "HONG KONG": "hk", ROMANIA: "ro", "CZECH REPUBLIC": "cz", CZECHIA: "cz",
  UKRAINE: "ua", TURKEY: "tr", PHILIPPINES: "ph", VIETNAM: "vn", INDONESIA: "id", ESTONIA: "ee",
  LITHUANIA: "lt", LATVIA: "lv", GREECE: "gr", HUNGARY: "hu", BULGARIA: "bg", EGYPT: "eg",
  NIGERIA: "ng", KENYA: "ke", "SOUTH AFRICA": "za", CHILE: "cl", PERU: "pe",
};

const clean = (s: string) => s.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
const countryOf = (t: string) => {
  const v = COUNTRIES[t.toUpperCase()];
  return v ? v.toUpperCase() : null;
};

/** Parse one location string such as "San Francisco, CA, United States" or "Remote - US". */
export function parseLocation(input: string): ParsedLocation {
  let s = input.replace(/[–—]/g, "-");
  const remote = /\b(remote|work from home|wfh|anywhere)\b/i.test(s);
  if (remote) s = s.replace(/\b(remote|work from home|wfh|anywhere)\b/gi, " ");
  // "Remote - US", "US-Remote", "(Remote)" leave separators behind.
  const parts = (remote ? s.split(/[,;/]|\s-\s|^-|-$/) : s.split(/[,;]/)).map(clean).filter((p) => /[a-z0-9]/i.test(p));
  const out: ParsedLocation = { country: null, remote };
  if (!parts.length) return out;

  const last = parts[parts.length - 1]!;
  const lastCountry = countryOf(last);
  if (lastCountry) {
    parts.pop();
    out.country = lastCountry;
  }
  // Remaining trailing token may be a US state / CA province (or a state name).
  if (parts.length) {
    const t = parts[parts.length - 1]!;
    const abbr = t.toUpperCase();
    const hasCity = parts.length >= 2;
    if (out.country === null || out.country === "US") {
      const byName = US_STATE_BY_NAME.get(t.toLowerCase());
      if (byName || (US_STATES[abbr] && (hasCity || out.country === "US") && !AMBIGUOUS_STATE.has(abbr))) {
        out.region = byName ?? abbr;
        out.country = "US";
        parts.pop();
      }
    }
    if (out.country === null || out.country === "CA") {
      if (CA_PROVINCES[abbr] && (hasCity || out.country === "CA") && parts.length) {
        out.region = abbr;
        out.country = "CA";
        parts.pop();
      }
    }
  }
  if (parts.length) out.city = parts.join(", ");
  return out;
}
