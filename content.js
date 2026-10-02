(() => {
  if (!/^\/jobs\/(?:search|collections)\//.test(location.pathname)) return;

  const cardSelectors = [
    ".jobs-search-results__list-item",
    "li[data-occludable-job-id]",
    "li[data-job-id]",
    ".job-card-container"
  ];
  let scanTimer = null;
  let noticeHost = null;

  const clean = (value) => (value || "").replace(/[\u00a0\t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  const lower = (value) => clean(value).toLocaleLowerCase();
  const isVisible = (element) => !!(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));

  function normalizeCard(element) {
    return element.closest(".jobs-search-results__list-item") ||
      element.closest("li[data-occludable-job-id]") ||
      element.closest("li[data-job-id]") ||
      element.closest(".job-card-container") || element;
  }

  function findCards() {
    const cards = new Set();
    for (const selector of cardSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        const card = normalizeCard(element);
        if (isVisible(card) && card.querySelector("a[href*='/jobs/view/']")) cards.add(card);
      }
    }
    return [...cards];
  }

  function companyFor(card) {
    const selectors = [
      ".job-card-container__company-name",
      "[class*='job-card-container__company-name']",
      ".artdeco-entity-lockup__subtitle",
      "[class*='entity-lockup__subtitle']"
    ];
    for (const selector of selectors) {
      const element = [...card.querySelectorAll(selector)].find(isVisible);
      const value = clean(element?.innerText || element?.textContent).split("\n")[0];
      if (value && value.length < 100) return value;
    }

    const companyLink = [...card.querySelectorAll("a[href*='/company/']")].find(isVisible);
    return clean(companyLink?.innerText || companyLink?.getAttribute("aria-label") || "").split("\n")[0];
  }

  function cityFor(card) {
    const selectors = [
      ".job-card-container__metadata-item",
      "[class*='job-card-container__metadata-item']",
      "[class*='job-card-container__metadata']",
      "[class*='location']"
    ];
    const checked = new Set();
    const rejected = /^(?:remote|hybrid|on[- ]?site|onsite|full[- ]?time|part[- ]?time|contract|temporary|internship|promoted|reposted|easy apply|\d+\s+(?:applicants?|days?|weeks?|hours?)\b.*)$/i;
    const valid = (value) => {
      const text = clean(value).split(/[·•|]/)[0].replace(/\s*\([^)]*(?:hybrid|remote|on[- ]?site)[^)]*\)/i, "").trim();
      if (text.length < 3 || text.length > 100 || rejected.test(text)) return "";
      if (/\$\s?\d|\b(?:applicants?|employees?|ago|full[- ]?time|part[- ]?time|contract)\b/i.test(text)) return "";
      return text;
    };

    for (const selector of selectors) {
      for (const element of card.querySelectorAll(selector)) {
        if (!isVisible(element) || checked.has(element)) continue;
        checked.add(element);
        const text = valid(element.innerText || element.textContent);
        if (!text) continue;
        if (text.includes(",")) return text;
        if (/location/i.test(element.className || "")) return text;
        if (selector.includes("metadata-item")) return text;
      }
    }
    return "";
  }

  function jobKey(company, city) {
    return `${lower(company)}|${lower(city)}`;
  }

  function createResultHost(card) {
    const host = document.createElement("div");
    host.dataset.howFarResult = "true";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { display:block; margin:8px 0 2px; font-family:Arial,sans-serif; }
      .row { display:flex; align-items:flex-start; gap:9px; padding:9px 10px; border:1px solid #d6e9df; border-radius:9px; background:#f3faf6; color:#20372b; }
      .pin { flex:0 0 auto; width:18px; height:18px; border-radius:50%; background:#d9efe2; color:#167449; font-size:12px; font-weight:700; line-height:18px; text-align:center; }
      .content { min-width:0; flex:1; }
      .distance { display:block; color:#176b46; font-size:12px; font-weight:700; line-height:1.3; }
      .address { display:block; margin-top:3px; color:#46584e; font-size:10px; line-height:1.35; overflow-wrap:anywhere; }
      .office { display:block; margin-top:3px; color:#78877e; font-size:9px; line-height:1.3; }
      .loading .distance { color:#66756c; font-weight:600; }
      .error { border-color:#eedbd8; background:#fff8f7; }
      .error .distance { color:#9b473d; }
      .attribution { flex:0 0 auto; align-self:flex-end; color:#7b8780; font-size:8px; white-space:nowrap; }
      .g { font-weight:700; letter-spacing:-.2px; background:linear-gradient(90deg,#4285f4 0 22%,#ea4335 22% 43%,#fbbc05 43% 63%,#4285f4 63% 79%,#34a853 79% 91%,#ea4335 91%); color:transparent; background-clip:text; -webkit-background-clip:text; }
    `;
    const row = document.createElement("div");
    row.className = "row loading";
    row.setAttribute("role", "status");
    const pin = document.createElement("span");
    pin.className = "pin";
    pin.textContent = "↗";
    const content = document.createElement("div");
    content.className = "content";
    const distance = document.createElement("strong");
    distance.className = "distance";
    distance.textContent = "Finding nearest office…";
    const address = document.createElement("span");
    address.className = "address";
    const office = document.createElement("span");
    office.className = "office";
    content.append(distance, address, office);
    const attribution = document.createElement("span");
    attribution.className = "attribution";
    attribution.innerHTML = '<span class="g">Google</span> Maps';
    row.append(pin, content, attribution);
    shadow.append(style, row);
    card.append(host);
    return { host, row, distance, address, office };
  }

  function showSetupNotice() {
    if (noticeHost?.isConnected) return;
    noticeHost = document.createElement("div");
    noticeHost.dataset.howFarNotice = "true";
    const shadow = noticeHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { position:fixed; z-index:999999; right:18px; bottom:18px; font-family:Arial,sans-serif; }
      .notice { max-width:320px; padding:12px 14px; border:1px solid #cce2d5; border-radius:11px; background:#f3faf6; box-shadow:0 5px 22px #163b2826; color:#234333; font-size:12px; line-height:1.45; }
      strong { color:#176b46; }
    `;
    const box = document.createElement("div");
    box.className = "notice";
    box.innerHTML = "<strong>How Far? setup needed.</strong><br>Click the extension icon once to save your home location and Places API key.";
    shadow.append(style, box);
    document.body.append(noticeHost);
  }

  function hideSetupNotice() {
    noticeHost?.remove();
    noticeHost = null;
  }

  function displayDistance(item, result) {
    if (!item?.host?.isConnected) return;
    item.row.classList.remove("loading", "error");
    if (result.status !== "found") {
      item.row.classList.add("error");
      item.distance.textContent = result.message || "No local office found.";
      item.address.textContent = "Check that the employer has a Google Maps office listing in this city.";
      item.office.textContent = "";
      return;
    }

    const km = result.distanceMeters / 1000;
    const distanceText = km >= 1 ? `${km.toFixed(km >= 100 ? 0 : 1)} km` : `${Math.round(result.distanceMeters)} m`;
    const mins = result.durationSeconds == null ? "" : ` · ~${Math.max(1, Math.round(result.durationSeconds / 60))} min drive`;
    item.distance.textContent = `${distanceText}${mins}`;
    item.address.textContent = result.address;
    item.office.textContent = `Nearest matching ${result.officeName} office · driving estimate`;
  }

  function scheduleScan(delay = 450) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, delay);
  }

  async function scan() {
    const settings = await chrome.storage.local.get(["apiKey", "homeLocation"]);
    if (!settings.apiKey || !settings.homeLocation) {
      showSetupNotice();
      return;
    }
    hideSetupNotice();

    const pending = new Map();
    for (const card of findCards()) {
      if (card.querySelector(":scope > [data-how-far-result='true']")) continue;
      const rect = card.getBoundingClientRect();
      if (rect.bottom < -150 || rect.top > window.innerHeight + 350) continue;

      const company = companyFor(card);
      const city = cityFor(card);
      if (!company || !city) continue;
      const key = jobKey(company, city);
      if (!pending.has(key)) pending.set(key, { key, company, city, cards: [] });
      pending.get(key).cards.push(card);
    }

    const batch = [...pending.values()].slice(0, 8);
    if (!batch.length) return;
    const uiByKey = new Map();
    for (const entry of batch) {
      uiByKey.set(entry.key, entry.cards.map((card) => createResultHost(card)));
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "lookup-office-distances",
        jobs: batch.map(({ key, company, city }) => ({ key, company, city }))
      });
      if (!response?.ok) {
        if (response?.code === "setup-required") showSetupNotice();
        for (const entry of batch) {
          for (const ui of uiByKey.get(entry.key) || []) {
            displayDistance(ui, { status: "error", message: response?.message || "Office lookup failed." });
          }
        }
      } else {
        const resultByKey = new Map((response.results || []).map((result) => [result.key, result]));
        for (const entry of batch) {
          const result = resultByKey.get(entry.key) || { status: "not-found", message: "No office result returned." };
          for (const ui of uiByKey.get(entry.key) || []) displayDistance(ui, result);
        }
      }
    } catch (_error) {
      for (const entry of batch) {
        for (const ui of uiByKey.get(entry.key) || []) {
          displayDistance(ui, { status: "error", message: "Could not reach Google Places. Check your API key and connection." });
        }
      }
    } finally {
      scheduleScan(700);
    }
  }

  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("scroll", () => scheduleScan(250), { passive: true });
  window.addEventListener("resize", () => scheduleScan(250));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || (!changes.apiKey && !changes.homeLocation)) return;
    scheduleScan(0);
  });

  scheduleScan(0);
})();
