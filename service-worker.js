const PLACES_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const OFFICE_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,routingSummaries";
const HOME_FIELD_MASK = "places.id,places.formattedAddress,places.location";

let cachedHome = null;

async function searchPlaces(textQuery, apiKey, fieldMask, routingOrigin) {
  const body = { textQuery, pageSize: 8 };
  if (routingOrigin) {
    body.routingParameters = {
      origin: routingOrigin,
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE"
    };
  }

  const response = await fetch(PLACES_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = payload?.error?.message || `Google Places returned HTTP ${response.status}`;
    throw new Error(reason);
  }
  return payload;
}

async function getHomeCoordinates(homeLocation, apiKey) {
  if (cachedHome?.query === homeLocation) return cachedHome.coordinates;

  const payload = await searchPlaces(homeLocation, apiKey, HOME_FIELD_MASK);
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
}

async function getOfficeDistance(job, homeCoordinates, apiKey) {
  const query = `${job.company} office in ${job.city}`;
  const payload = await searchPlaces(query, apiKey, OFFICE_FIELD_MASK, homeCoordinates);
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
  const closest = candidates[0];
  const durationText = closest.summary.legs[0].duration || "";
  const durationSeconds = Number.parseFloat(durationText.replace(/s$/, ""));
  return {
    key: job.key,
    status: "found",
    officeName: closest.place.displayName?.text || job.company,
    address: closest.place.formattedAddress,
    placeId: closest.place.id,
    distanceMeters: closest.meters,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
    matches: candidates.length
  };
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
      results.push(await getOfficeDistance(job, homeCoordinates, apiKey));
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
