const homeInput = document.querySelector("#homeLocation");
const keyInput = document.querySelector("#apiKey");
const saveButton = document.querySelector("#saveSetup");
const status = document.querySelector("#status");

async function loadSetup() {
  const saved = await chrome.storage.local.get(["homeLocation", "apiKey"]);
  homeInput.value = saved.homeLocation || "";
  keyInput.value = saved.apiKey || "";
  if (saved.homeLocation && saved.apiKey) {
    status.textContent = "Setup saved. Office addresses and distances appear on LinkedIn job searches.";
  }
}

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

loadSetup();
