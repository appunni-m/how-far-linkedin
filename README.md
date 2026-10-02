# How Far? for LinkedIn

How Far? adds matching company office addresses and estimated home-to-office driving distances directly to LinkedIn job search cards. It uses Google Places Text Search with routing summaries and lists returned offices from closest to farthest.

## One-time setup

1. In Google Cloud, link a billing account to a project and enable **Places API (New)**.
2. Create an API key restricted to **Places API (New)**. Set a conservative API quota and a billing alert.
3. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this project folder.
4. Open the extension popup once, enter your full home address and API key, and choose **Save setup**.
5. Open or refresh a LinkedIn job search page. Each visible job card with a company and city should show up to eight matching offices, numbered, color-coded, and sorted from closest to farthest. More cards are checked as you scroll.

## How it works

- The extension reads job cards on LinkedIn `/jobs/search/`, `/jobs/search-results/`, and `/jobs/collections/` pages.
- It searches Google Places for the employer's office in the job's city and asks for route summaries from your home location.
- It displays matching office results with each address, road distance, and estimated drive time. The route summary does not include live traffic.
- If a company does not have a suitable Google Maps office listing, the card reports that no office was found.
- Duplicate cards in the same scan share one lookup, and simultaneous requests for the same company, city, and home location are coalesced.
- Google requests are serialized, capped at 30 per rolling minute, and spaced at least one second apart. The limiter state persists across browser restarts. Google quota errors start a one-minute cooldown.

## Caching and request limits

This extension does not save Google Places addresses or driving results as a long-term cache. Google allows Place IDs to be stored long term, but an ID by itself cannot provide a current address or route summary; those still need a fresh API lookup. The extension stores your home location and API key for setup, plus request limiter timestamps and cooldown. It does not persist Google Places result content. While a LinkedIn page remains open, result cards already completed are left in place and duplicate cards share a lookup.

## Privacy and API key

The home address and API key are stored in `chrome.storage.local` in this Chrome profile. The extension sends the home address, employer name, and job city to Google Places when it looks up results. Because this version calls Google directly without a backend, the API key is present in local extension storage and is not a strong secret. Restrict it to Places API (New), use a low quota, and do not reuse a key from another app. Google Maps Platform requires billing and charges by API usage; check the current [Places API pricing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing).

Google Places requires attribution when its results are displayed outside a Google map; the inline result includes Google Maps attribution. See [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies).
