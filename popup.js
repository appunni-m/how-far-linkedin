const homeInput = document.querySelector("#homeLocation");
const keyInput = document.querySelector("#apiKey");
const saveButton = document.querySelector("#saveSetup");
const status = document.querySelector("#status");
const pricingRegion = document.querySelector("#pricingRegion");
const USAGE_STORAGE_KEY = "howFarUsageV1";
const clearCacheButton = document.querySelector("#clearCache");
const PRICE_TABLES = {
  global: {
    label: "Global",
    pricingUrl: "https://developers.google.com/maps/billing-and-pricing/pricing",
    home: {
      freeCap: 5000,
      tiers: [
        { upTo: 100_000, dollarsPerThousand: 32 },
        { upTo: 500_000, dollarsPerThousand: 25.6 },
        { upTo: 1_000_000, dollarsPerThousand: 19.2 },
        { upTo: 5_000_000, dollarsPerThousand: 9.6 },
        { upTo: Infinity, dollarsPerThousand: 2.4 }
      ]
    },
    office: {
      freeCap: 1000,
      tiers: [
        { upTo: 100_000, dollarsPerThousand: 40 },
        { upTo: 500_000, dollarsPerThousand: 32 },
        { upTo: 1_000_000, dollarsPerThousand: 24 },
        { upTo: 5_000_000, dollarsPerThousand: 12 },
        { upTo: Infinity, dollarsPerThousand: 3.4 }
      ]
    }
  },
  india: {
    label: "India",
    pricingUrl: "https://developers.google.com/maps/billing-and-pricing/pricing-india",
    home: {
      freeCap: 35_000,
      tiers: [
        { upTo: 5_000_000, dollarsPerThousand: 9.6 },
        { upTo: Infinity, dollarsPerThousand: 2.4 }
      ]
    },
    office: {
      freeCap: 7000,
      tiers: [
        { upTo: 5_000_000, dollarsPerThousand: 12 },
        { upTo: Infinity, dollarsPerThousand: 3.4 }
      ]
    }
  }
};

const usageElements = {
  estimatedCost: document.querySelector("#estimatedCost"),
  requestsSent: document.querySelector("#requestsSent"),
  successfulRequests: document.querySelector("#successfulRequests"),
  cacheHits: document.querySelector("#cacheHits"),
  cachedQueries: document.querySelector("#cachedQueries"),
  homeDetail: document.querySelector("#homeUsageDetail"),
  homeCost: document.querySelector("#homeUsageCost"),
  homeMeter: document.querySelector("#homeUsageMeter"),
  officeDetail: document.querySelector("#officeUsageDetail"),
  officeCost: document.querySelector("#officeUsageCost"),
  officeMeter: document.querySelector("#officeUsageMeter"),
  pricingRates: document.querySelector("#pricingRates"),
  pricingLink: document.querySelector("#pricingLink")
};

let currentUsage = null;

function usageMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function asCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

function formatUSD(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount > 0 && amount < 1 ? 4 : 2,
    maximumFractionDigits: 4
  }).format(amount);
}

function calculateCost(eventCount, pricing) {
  let cost = 0;
  let lowerBound = 0;
  for (const tier of pricing.tiers) {
    const start = Math.max(lowerBound, pricing.freeCap);
    const end = Math.min(eventCount, tier.upTo);
    if (end > start) cost += ((end - start) / 1000) * tier.dollarsPerThousand;
    lowerBound = tier.upTo;
    if (eventCount <= tier.upTo) break;
  }

  const paidEvents = Math.max(0, eventCount - pricing.freeCap);
  return {
    cost,
    paidEvents,
    freeRemaining: Math.max(0, pricing.freeCap - eventCount),
    freeUsed: Math.min(eventCount, pricing.freeCap)
  };
}

function renderSkuUsage(elements, events, pricing) {
  const estimate = calculateCost(events, pricing);
  elements.detail.textContent = `${events.toLocaleString()} billable · ${estimate.freeUsed.toLocaleString()} free · ${estimate.paidEvents.toLocaleString()} paid · ${estimate.freeRemaining.toLocaleString()} left`;
  elements.cost.textContent = formatUSD(estimate.cost);
  elements.meter.style.width = `${Math.min(100, (events / pricing.freeCap) * 100)}%`;
  return estimate.cost;
}

function renderUsage() {
  const table = PRICE_TABLES[pricingRegion.value] || PRICE_TABLES.global;
  const usage = currentUsage?.month === usageMonth() ? currentUsage : {};
  const sent = usage.requestsSent || {};
  const successful = usage.successfulRequests || {};
  const homeEvents = asCount(successful.homeTextSearchPro);
  const officeEvents = asCount(successful.officeTextSearchEnterpriseAtmosphere);
  const sentTotal = asCount(sent.homeTextSearchPro) + asCount(sent.officeTextSearchEnterpriseAtmosphere);
  const successfulTotal = homeEvents + officeEvents;
  const cacheHitTotal = asCount(usage.cacheHits?.homeTextSearchPro) + asCount(usage.cacheHits?.officeTextSearchEnterpriseAtmosphere);

  const homeCost = renderSkuUsage({
    detail: usageElements.homeDetail,
    cost: usageElements.homeCost,
    meter: usageElements.homeMeter
  }, homeEvents, table.home);
  const officeCost = renderSkuUsage({
    detail: usageElements.officeDetail,
    cost: usageElements.officeCost,
    meter: usageElements.officeMeter
  }, officeEvents, table.office);

  usageElements.estimatedCost.textContent = formatUSD(homeCost + officeCost);
  usageElements.requestsSent.textContent = sentTotal.toLocaleString();
  usageElements.successfulRequests.textContent = successfulTotal.toLocaleString();
  usageElements.cacheHits.textContent = cacheHitTotal.toLocaleString();
  usageElements.pricingRates.textContent = `First paid tier after free usage: ${formatUSD(table.home.tiers[0].dollarsPerThousand)} / 1,000 home searches; ${formatUSD(table.office.tiers[0].dollarsPerThousand)} / 1,000 office route searches.`;
  usageElements.pricingLink.href = table.pricingUrl;
}

async function loadSetup() {
  const saved = await chrome.storage.local.get(["homeLocation", "apiKey"]);
  homeInput.value = saved.homeLocation || "";
  keyInput.value = saved.apiKey || "";
  if (saved.homeLocation && saved.apiKey) {
    status.textContent = "Setup saved. Office addresses and distances appear on LinkedIn job searches.";
  }
}

async function loadMetrics() {
  const [saved, cacheStats] = await Promise.all([
    chrome.storage.local.get([USAGE_STORAGE_KEY, "pricingRegion"]),
    chrome.runtime.sendMessage({ type: "get-places-cache-stats" }).catch(() => null)
  ]);
  currentUsage = saved[USAGE_STORAGE_KEY] || null;
  usageElements.cachedQueries.textContent = Number.isFinite(cacheStats?.count) ? cacheStats.count.toLocaleString() : "Unavailable";
  pricingRegion.value = PRICE_TABLES[saved.pricingRegion] ? saved.pricingRegion : "global";
  renderUsage();
}

clearCacheButton.addEventListener("click", async () => {
  const cacheStats = await chrome.runtime.sendMessage({ type: "get-places-cache-stats" }).catch(() => null);
  const count = Number.isFinite(cacheStats?.count) ? cacheStats.count : 0;
  if (!count) {
    status.textContent = cacheStats?.ok === false
      ? cacheStats.message || "Could not read the saved query count."
      : "There are no saved query results to clear.";
    delete status.dataset.tone;
    return;
  }

  if (!window.confirm(`Clear ${count} saved query results? Their next use will send requests to Google.`)) return;
  const result = await chrome.runtime.sendMessage({ type: "clear-places-cache" }).catch(() => null);
  if (!result?.ok) {
    status.textContent = result?.message || "Could not clear the saved query results.";
    status.dataset.tone = "error";
    return;
  }
  status.textContent = "Saved query results cleared. The next lookup will contact Google.";
  delete status.dataset.tone;
});

saveButton.addEventListener("click", async () => {
  const homeLocation = homeInput.value.trim();
  const apiKey = keyInput.value.trim();
  if (!homeLocation || !apiKey) {
    status.textContent = "Enter both your home location and Google Places API key.";
    status.dataset.tone = "error";
    return;
  }

  await chrome.storage.local.set({ homeLocation, apiKey });
  status.textContent = "Saved. LinkedIn job cards will show office addresses and distances.";
  delete status.dataset.tone;
});

pricingRegion.addEventListener("change", async () => {
  await chrome.storage.local.set({ pricingRegion: pricingRegion.value });
  renderUsage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[USAGE_STORAGE_KEY]) {
    currentUsage = changes[USAGE_STORAGE_KEY].newValue || null;
    renderUsage();
  }
  if (changes.pricingRegion && PRICE_TABLES[changes.pricingRegion.newValue]) {
    pricingRegion.value = changes.pricingRegion.newValue;
    renderUsage();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "places-cache-updated" && Number.isFinite(message.count)) {
    usageElements.cachedQueries.textContent = message.count.toLocaleString();
  }
});

loadSetup();
loadMetrics();
