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
- Successful Places API responses are saved in local browser storage and reused for identical requests, including home-location searches and office routes. A cache hit skips the Google request and does not count toward API usage or estimated cost.
- Google requests are serialized, capped at 30 per rolling minute, and spaced at least one second apart. The limiter state persists across browser restarts. Google quota errors start a one-minute cooldown.
- The extension popup tracks sent requests, successful Text Search events, and cache hits for the local calendar month. It estimates free and paid use separately for the home lookup (Text Search Pro) and office route lookup (Text Search Enterprise + Atmosphere, because the request asks for `routingSummaries`).
- The popup includes Global and India public rate lists. Its estimate only counts this extension's traffic and assumes the billing account's free allowance and volume tiers have no other project usage; Google Cloud billing remains authoritative.

## Caching and request limits

The extension saves up to 500 successful Places API responses in `chrome.storage.local`, keyed by a hash of the request text, requested fields, and route origin. Results persist across page reloads and browser restarts; the oldest saved query is evicted when the limit is reached. Use **Clear cache** in the popup to remove them and make future lookups call Google again. Failed API responses are not cached.

## Privacy and API key

The home address, API key, and saved Places API responses are stored in `chrome.storage.local` in this Chrome profile. The extension sends the home address, employer name, and job city to Google Places when it performs a new lookup. Because this version calls Google directly without a backend, the API key is present in local extension storage and is not a strong secret. Restrict it to Places API (New), use a low quota, and do not reuse a key from another app. Google Maps Platform requires billing and charges by API usage; check the current [Places API pricing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing).

Google Places requires attribution when its results are displayed outside a Google map; the inline result includes Google Maps attribution. See [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies).
