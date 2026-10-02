# How Far? for LinkedIn

How Far? adds an office address and estimated home-to-office driving distance directly to LinkedIn job search cards. It uses Google Places Text Search with routing summaries and chooses the closest matching office returned for the employer and job city.

## One-time setup

1. In Google Cloud, link a billing account to a project and enable **Places API (New)**.
2. Create an API key restricted to **Places API (New)**. Set a conservative API quota and a billing alert.
3. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this project folder.
4. Open the extension popup once, enter your full home address and API key, and choose **Save setup**.
5. Open or refresh a LinkedIn job search page. Each visible job card with a company and city should show its closest matching office address and driving estimate. More cards are checked as you scroll.

## How it works

- The extension reads job cards on LinkedIn `/jobs/search/`, `/jobs/search-results/`, and `/jobs/collections/` pages.
- It searches Google Places for the employer's office in the job's city and asks for route summaries from your home location.
- It displays the closest office result with its address, road distance, and estimated drive time. The route summary does not include live traffic.
- If a company does not have a suitable Google Maps office listing, the card reports that no office was found.

## Privacy and API key

The home address and API key are stored in `chrome.storage.local` in this Chrome profile. The extension sends the home address, employer name, and job city to Google Places when it looks up results. Because this version calls Google directly without a backend, the API key is present in local extension storage and is not a strong secret. Restrict it to Places API (New), use a low quota, and do not reuse a key from another app. Google Maps Platform requires billing and charges by API usage; check the current [Places API pricing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing).

Google Places requires attribution when its results are displayed outside a Google map; the inline result includes Google Maps attribution. See [Places API policies](https://developers.google.com/maps/documentation/places/web-service/policies).
