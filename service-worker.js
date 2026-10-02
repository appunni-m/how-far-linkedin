const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const OFFICE_FIELD_MASK = "places.displayName,places.formattedAddress,routingSummaries";
const HOME_FIELD_MASK = "places.location";
const RATE_LIMIT_STORAGE_KEY = "howFarRequestRateV1";
const USAGE_STORAGE_KEY = "howFarUsageV1";
const HOME_SEARCH_USAGE = "homeTextSearchPro";
const OFFICE_SEARCH_USAGE = "officeTextSearchEnterpriseAtmosphere";
const REQUEST_WINDOW_MS = 60_000;
const MIN_REQUEST_GAP_MS = 1_000;
const MAX_REQUESTS_PER_MINUTE = 30;
const QUOTA_COOLDOWN_MS = 60_000;

let cachedHome = null;
let homeLookupInFlight = null;
let lastRequestAt = 0;
let apiRequestQueue = Promise.resolve();
const officeLookupInFlight = new Map();

function currentUsageMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function recordApiRequest(usageType, succeeded) {
  try {
    const month = currentUsageMonth();
    const stored = await chrome.storage.local.get(USAGE_STORAGE_KEY);
    const previous = stored[USAGE_STORAGE_KEY];
    const usage = previous?.month === month
      ? {
          ...previous,
          requestsSent: { ...(previous.requestsSent || {}) },
          successfulRequests: { ...(previous.successfulRequests || {}) }
        }
      : { month, requestsSent: {}, successfulRequests: {} };

    usage.requestsSent[usageType] = (Number(usage.requestsSent[usageType]) || 0) + 1;
    if (succeeded) {
      usage.successfulRequests[usageType] = (Number(usage.successfulRequests[usageType]) || 0) + 1;
    }
    usage.updatedAt = Date.now();
    await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: usage });
  } catch (_error) {
    // Metrics should never block a Places lookup.
  }
}

const pause = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

async function reserveRequestSlot() {
  while (true) {
    const stored = await chrome.storage.local.get(RATE_LIMIT_STORAGE_KEY);
    const state = stored[RATE_LIMIT_STORAGE_KEY] || {};
    const now = Date.now();
    const cooldownUntil = Number(state.cooldownUntil) || 0;
    if (cooldownUntil > now) {
      const seconds = Math.ceil((cooldownUntil - now) / 1000);
      throw new Error(`Google Places is cooling down after a rate limit. Try again in about ${seconds} seconds.`);
    }

    const timestamps = Array.isArray(state.timestamps) ? state.timestamps : [];
    const recentTimestamps = timestamps.filter((timestamp) => Number.isFinite(timestamp) && now - timestamp < REQUEST_WINDOW_MS);
    const previousRequestAt = Math.max(lastRequestAt, Number(state.lastRequestAt) || 0);
    const gapWaitMs = Math.max(0, MIN_REQUEST_GAP_MS - (now - previousRequestAt));
    const windowWaitMs = recentTimestamps.length >= MAX_REQUESTS_PER_MINUTE
      ? Math.max(0, recentTimestamps[0] + REQUEST_WINDOW_MS - now)
      : 0;
    const waitMs = Math.max(gapWaitMs, windowWaitMs);
    if (waitMs > 0) {
      await pause(waitMs);
      continue;
    }

    const requestedAt = Date.now();
    recentTimestamps.push(requestedAt);
    await chrome.storage.local.set({
      [RATE_LIMIT_STORAGE_KEY]: {
        timestamps: recentTimestamps,
        lastRequestAt: requestedAt,
        cooldownUntil: 0
      }
    });
    lastRequestAt = requestedAt;
    return;
  }
}

function queuePlacesRequest(request) {
  const queuedRequest = apiRequestQueue.then(async () => {
    await reserveRequestSlot();
    return request();
  });
  apiRequestQueue = queuedRequest.catch(() => undefined);
  return queuedRequest;
}

async function setQuotaCooldown(response) {
  const stored = await chrome.storage.local.get(RATE_LIMIT_STORAGE_KEY);
  const state = stored[RATE_LIMIT_STORAGE_KEY] || {};
  const retryAfterHeader = response.headers.get("Retry-After") || "";
  const retryAfterSeconds = Number(retryAfterHeader);
  const retryAfterDate = Date.parse(retryAfterHeader);
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? retryAfterSeconds * 1000
    : Number.isFinite(retryAfterDate) ? Math.max(0, retryAfterDate - Date.now()) : 0;
  const cooldownMs = Math.max(QUOTA_COOLDOWN_MS, retryAfterMs);
  await chrome.storage.local.set({
    [RATE_LIMIT_STORAGE_KEY]: {
      ...state,
      cooldownUntil: Math.max(Number(state.cooldownUntil) || 0, Date.now() + cooldownMs)
    }
  });
}

async function searchPlaces(textQuery, apiKey, fieldMask, routingOrigin, usageType) {
  const body = { textQuery, pageSize: 8 };
  if (routingOrigin) {
    body.routingParameters = {
      origin: routingOrigin,
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE"
    };
  }

  return queuePlacesRequest(async () => {
    let response;
    try {
      response = await fetch(PLACES_SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": fieldMask
        },
        body: JSON.stringify(body)
      });

      const payload = await response.json().catch(() => ({}));
      await recordApiRequest(usageType, response.ok);
      if (!response.ok) {
        const reason = payload?.error?.message || `Google Places returned HTTP ${response.status}`;
        const isQuotaError = response.status === 429 ||
          payload?.error?.status === "RESOURCE_EXHAUSTED" ||
          /rate.?limit|quota|too many requests/i.test(reason);
        if (isQuotaError) await setQuotaCooldown(response);
        throw new Error(reason);
      }
      return payload;
    } catch (error) {
      if (!response) await recordApiRequest(usageType, false);
      throw error;
    }
  });
}

async function getHomeCoordinates(homeLocation, apiKey) {
  if (cachedHome?.query === homeLocation) return cachedHome.coordinates;
  if (homeLookupInFlight?.query === homeLocation) return homeLookupInFlight.promise;

  const promise = (async () => {
    const payload = await searchPlaces(homeLocation, apiKey, HOME_FIELD_MASK, null, HOME_SEARCH_USAGE);
    const place = payload.places?.find((candidate) =>
      Number.isFinite(candidate.location?.latitude) && Number.isFinite(candidate.location?.longitude)
    );
    if (!place) throw new Error("Google Places couldn't find that home location. Add a fuller address in the extension setup.");

    const coordinates = {
      latitude: place.location.latitude,
      longitude: place.location.longitude
    };
    cachedHome = { query: homeLocation, coordinates };
    return coordinates;
  })();

  homeLookupInFlight = { query: homeLocation, promise };
  try {
    return await promise;
  } finally {
    if (homeLookupInFlight?.promise === promise) homeLookupInFlight = null;
  }
}

async function getOfficeDistance(job, homeCoordinates, apiKey) {
  const query = `${job.company} office in ${job.city}`;
  const payload = await searchPlaces(query, apiKey, OFFICE_FIELD_MASK, homeCoordinates, OFFICE_SEARCH_USAGE);
  const places = payload.places || [];
  const summaries = payload.routingSummaries || [];
  const candidates = places.map((place, index) => ({
    place,
    summary: summaries[index],
    meters: summaries[index]?.legs?.[0]?.distanceMeters
  })).filter((item) => Number.isFinite(item.meters) && item.place.formattedAddress);

  if (!candidates.length) {
    return { key: job.key, status: "not-found", message: "No mapped office with a route was found in this city." };
  }

  candidates.sort((a, b) => a.meters - b.meters);
  const offices = candidates.map(({ place, summary, meters }) => {
    const durationText = summary.legs[0].duration || "";
    const durationSeconds = Number.parseFloat(durationText.replace(/s$/, ""));
    return {
      name: place.displayName?.text || job.company,
      address: place.formattedAddress,
      distanceMeters: meters,
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null
    };
  });

  return { key: job.key, status: "found", offices, matches: offices.length };
}

async function getOfficeDistanceDeduplicated(job, homeCoordinates, apiKey, homeLocation) {
  const lookupKey = JSON.stringify([
    homeLocation.replace(/\s+/g, " ").trim().toLocaleLowerCase(),
    job.company.replace(/\s+/g, " ").trim().toLocaleLowerCase(),
    job.city.replace(/\s+/g, " ").trim().toLocaleLowerCase()
  ]);
  const existing = officeLookupInFlight.get(lookupKey);
  if (existing) return { ...(await existing), key: job.key };

  const promise = getOfficeDistance(job, homeCoordinates, apiKey);
  officeLookupInFlight.set(lookupKey, promise);
  try {
    return { ...(await promise), key: job.key };
  } finally {
    if (officeLookupInFlight.get(lookupKey) === promise) officeLookupInFlight.delete(lookupKey);
  }
}

async function lookupBatch(jobs) {
  const { apiKey, homeLocation } = await chrome.storage.local.get(["apiKey", "homeLocation"]);
  if (!apiKey || !homeLocation) {
    return { ok: false, code: "setup-required", message: "Set your home location and Google Places API key in the extension." };
  }

  const homeCoordinates = await getHomeCoordinates(homeLocation, apiKey);
  const results = [];
  for (const job of jobs) {
    try {
      results.push(await getOfficeDistanceDeduplicated(job, homeCoordinates, apiKey, homeLocation));
    } catch (error) {
      results.push({ key: job.key, status: "error", message: error.message || "Office lookup failed." });
    }
  }
  return { ok: true, results };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "lookup-office-distances") return false;

  lookupBatch(Array.isArray(message.jobs) ? message.jobs.slice(0, 10) : [])
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, code: "lookup-error", message: error.message || "Office lookup failed." }));
  return true;
});
