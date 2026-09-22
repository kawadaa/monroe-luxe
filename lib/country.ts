import "server-only";

const COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "cloudfront-viewer-country",
  "x-appengine-country",
  "x-country-code",
] as const;

export function normalizeCountryCode(value: string | null | undefined) {
  const code = value?.split(",", 1)[0]?.trim().toUpperCase() || "";
  if (!/^[A-Z]{2}$/.test(code) || code === "XX") return null;
  return code;
}

export function countryCodeFromHeaders(headers: Headers) {
  for (const header of COUNTRY_HEADERS) {
    const countryCode = normalizeCountryCode(headers.get(header));
    if (countryCode) return countryCode;
  }
  return null;
}
