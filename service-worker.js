const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const OFFICE_FIELD_MASK = "places.displayName,places.formattedAddress,routingSummaries";
const HOME_FIELD_MASK = "places.location";
const RATE_LIMIT_STORAGE_KEY = "howFarRequestRateV1";
const USAGE_STORAGE_KEY = "howFarUsageV1";
const PLACES_RESPONSE_CACHE_STORAGE_KEY = "howFarPlacesResponseCacheV1";
const PLACES_CACHE_DB_NAME = "howFarPlacesResponseCache";
const PLACES_CACHE_DB_VERSION = 1;
const PLACES_CACHE_STORE_NAME = "responses";
const PLACES_CACHE_METADATA_STORE_NAME = "metadata";
const LEGACY_CACHE_MIGRATION_KEY = "legacy-chrome-storage-cache-v1-migrated";
const HOME_SEARCH_USAGE = "homeTextSearchPro";
const OFFICE_SEARCH_USAGE = "officeTextSearchEnterpriseAtmosphere";
const REQUEST_WINDOW_MS = 60_000;
const MIN_REQUEST_GAP_MS = 1_000;
const MAX_REQUESTS_PER_MINUTE = 30;
const QUOTA_COOLDOWN_MS = 60_000;
const MAX_CACHED_PLACES_RESPONSES = 100_000;

let cachedHome = null;
let homeLookupInFlight = null;
let lastRequestAt = 0;
let apiRequestQueue = Promise.resolve();
const officeLookupInFlight = new Map();
const placesRequestInFlight = new Map();
let placesCacheDbPromise = null;

function currentUsageMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function recordApiRequest(usageType, succeeded) {
  try {
    const month = currentUsageMonth();
    const stored = await chrome.storage.local.get(USAGE_STORAGE_KEY);
    const previous = stored[USAGE_STORAGE_KEY];
    const usage = getMonthUsage(previous, month);

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

function getMonthUsage(previous, month = currentUsageMonth()) {
  return previous?.month === month
    ? {
        ...previous,
        requestsSent: { ...(previous.requestsSent || {}) },
        successfulRequests: { ...(previous.successfulRequests || {}) },
        cacheHits: { ...(previous.cacheHits || {}) }
      }
    : { month, requestsSent: {}, successfulRequests: {}, cacheHits: {} };
}

async function recordCacheHit(usageType) {
  try {
    const month = currentUsageMonth();
    const stored = await chrome.storage.local.get(USAGE_STORAGE_KEY);
    const usage = getMonthUsage(stored[USAGE_STORAGE_KEY], month);
    usage.cacheHits[usageType] = (Number(usage.cacheHits[usageType]) || 0) + 1;
    usage.updatedAt = Date.now();
    await chrome.storage.local.set({ [USAGE_STORAGE_KEY]: usage });
  } catch (_error) {
    // Cache usage metrics must never block a Places lookup.
  }
}

async function placesRequestCacheKey(body, fieldMask) {
  const request = JSON.stringify({ url: PLACES_SEARCH_URL, body, fieldMask });
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (_error) {
    let first = 2166136261;
    let second = 0x9e3779b1;
    for (let index = 0; index < request.length; index += 1) {
      const code = request.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 2246822519);
    }
    return `local-${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
  }
}

function idbRequestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function idbTransactionDone(transaction) {
  const completion = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted."));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
  });
  // A related request can fail first; keep this rejection handled if its await is skipped.
  completion.catch(() => {});
  return completion;
}

async function migrateLegacyPlacesCache(db) {
  const readTransaction = db.transaction(PLACES_CACHE_METADATA_STORE_NAME, "readonly");
  const migrationValue = await idbRequestResult(
    readTransaction.objectStore(PLACES_CACHE_METADATA_STORE_NAME).get(LEGACY_CACHE_MIGRATION_KEY)
  );
  await idbTransactionDone(readTransaction);

  if (!migrationValue) {
    const stored = await chrome.storage.local.get(PLACES_RESPONSE_CACHE_STORAGE_KEY);
    const legacyEntries = Object.entries(stored[PLACES_RESPONSE_CACHE_STORAGE_KEY] || {});
    const transaction = db.transaction(
      [PLACES_CACHE_STORE_NAME, PLACES_CACHE_METADATA_STORE_NAME],
      "readwrite"
    );
    const transactionDone = idbTransactionDone(transaction);
    const responseStore = transaction.objectStore(PLACES_CACHE_STORE_NAME);
    for (const [key, entry] of legacyEntries) {
      if (entry && Object.prototype.hasOwnProperty.call(entry, "payload")) {
        responseStore.put({
          key,
          cachedAt: Number(entry.cachedAt) || Date.now(),
          payload: entry.payload
        });
      }
    }
    transaction.objectStore(PLACES_CACHE_METADATA_STORE_NAME).put(true, LEGACY_CACHE_MIGRATION_KEY);
    await transactionDone;
  }

  // If the worker stopped after committing the migration marker, remove the old copy on next open.
  await chrome.storage.local.remove(PLACES_RESPONSE_CACHE_STORAGE_KEY);
}

function openPlacesCacheDb() {
  if (!placesCacheDbPromise) {
    placesCacheDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(PLACES_CACHE_DB_NAME, PLACES_CACHE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PLACES_CACHE_STORE_NAME)) {
          const responseStore = db.createObjectStore(PLACES_CACHE_STORE_NAME, { keyPath: "key" });
          responseStore.createIndex("cachedAt", "cachedAt", { unique: false });
        }
        if (!db.objectStoreNames.contains(PLACES_CACHE_METADATA_STORE_NAME)) {
          db.createObjectStore(PLACES_CACHE_METADATA_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open the Places response cache."));
      request.onblocked = () => reject(new Error("The Places response cache is blocked by another browser operation."));
    }).then(async (db) => {
      try {
        await migrateLegacyPlacesCache(db);
      } catch (_error) {
        // A migration problem must not stop fresh API lookups or cache reads.
      }
      return db;
    }).catch((error) => {
      placesCacheDbPromise = null;
      throw error;
    });
  }
  return placesCacheDbPromise;
}

async function readCachedPlacesResponse(cacheKey) {
  try {
    const db = await openPlacesCacheDb();
    const transaction = db.transaction(PLACES_CACHE_STORE_NAME, "readonly");
    const transactionDone = idbTransactionDone(transaction);
    const entry = await idbRequestResult(transaction.objectStore(PLACES_CACHE_STORE_NAME).get(cacheKey));
    await transactionDone;
    return entry ? { hit: true, payload: entry.payload } : { hit: false };
  } catch (_error) {
    return { hit: false };
  }
}

async function getPlacesCacheCount() {
  const db = await openPlacesCacheDb();
  const transaction = db.transaction(PLACES_CACHE_STORE_NAME, "readonly");
  const transactionDone = idbTransactionDone(transaction);
  const count = await idbRequestResult(transaction.objectStore(PLACES_CACHE_STORE_NAME).count());
  await transactionDone;
  return count;
}

async function notifyPlacesCacheUpdated(count) {
  try {
    await chrome.runtime.sendMessage({ type: "places-cache-updated", count });
  } catch (_error) {
    // The popup may not be open.
  }
}

async function cachePlacesResponse(cacheKey, payload) {
  try {
    const db = await openPlacesCacheDb();
    const transaction = db.transaction(PLACES_CACHE_STORE_NAME, "readwrite");
    const transactionDone = idbTransactionDone(transaction);
    const responseStore = transaction.objectStore(PLACES_CACHE_STORE_NAME);
    responseStore.put({ key: cacheKey, cachedAt: Date.now(), payload });

    const count = await idbRequestResult(responseStore.count());
    let toRemove = count - MAX_CACHED_PLACES_RESPONSES;
    if (toRemove > 0) {
      await new Promise((resolve, reject) => {
        const cursorRequest = responseStore.index("cachedAt").openCursor();
        cursorRequest.onerror = () => reject(cursorRequest.error || new Error("Could not trim the Places response cache."));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor || toRemove <= 0) {
            resolve();
            return;
          }
          cursor.delete();
          toRemove -= 1;
          cursor.continue();
        };
      });
    }
    await transactionDone;
    await notifyPlacesCacheUpdated(Math.min(count, MAX_CACHED_PLACES_RESPONSES));
  } catch (_error) {
    // Keep serving the live result if IndexedDB is unavailable or cannot store it.
  }
}

async function clearPlacesCache() {
  const db = await openPlacesCacheDb();
  const transaction = db.transaction(PLACES_CACHE_STORE_NAME, "readwrite");
  const transactionDone = idbTransactionDone(transaction);
  transaction.objectStore(PLACES_CACHE_STORE_NAME).clear();
  await transactionDone;
  await notifyPlacesCacheUpdated(0);
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

  const cacheKey = await placesRequestCacheKey(body, fieldMask);
  const cached = await readCachedPlacesResponse(cacheKey);
  if (cached.hit) {
    await recordCacheHit(usageType);
    return cached.payload;
  }

  const inFlight = placesRequestInFlight.get(cacheKey);
  if (inFlight) {
    await recordCacheHit(usageType);
    return inFlight;
  }

  const promise = queuePlacesRequest(async () => {
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
      await cachePlacesResponse(cacheKey, payload);
      return payload;
    } catch (error) {
      if (!response) await recordApiRequest(usageType, false);
      throw error;
    }
  });

  placesRequestInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    if (placesRequestInFlight.get(cacheKey) === promise) placesRequestInFlight.delete(cacheKey);
  }
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
  if (message?.type === "get-places-cache-stats") {
    getPlacesCacheCount()
      .then((count) => sendResponse({ ok: true, count }))
      .catch((error) => sendResponse({ ok: false, message: error.message || "Could not read the saved query count." }));
    return true;
  }

  if (message?.type === "clear-places-cache") {
    clearPlacesCache()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: error.message || "Could not clear the saved query results." }));
    return true;
  }

  if (message?.type !== "lookup-office-distances") return false;

  lookupBatch(Array.isArray(message.jobs) ? message.jobs.slice(0, 10) : [])
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, code: "lookup-error", message: error.message || "Office lookup failed." }));
  return true;
});
