# Preflight

**Ticket in, boarding pass out.** A travel-readiness agent built on the [Flyo Web Check-in API](https://www.flyo.ai/en/api-docs).

Flyo's check-in agent takes over once a booking has all its data. Preflight handles the step before that:

1. It reads the e-ticket (PDF, photo or pasted email), using a vision LLM or a built-in parser.
2. It calls Flyo `subscribe` right away. Missing details come back as `MISSING_INFO` rather than a rejection.
3. It runs **readiness checks** that Flyo doesn't do:
   - passport validity per destination
   - visas, and transit visas (e.g. the UK DATV, waived for travellers with a US visa)
   - ticket name vs. passport name
   - ICAO MRZ check digits, which catch misread passport numbers
   - minimum connection times
   - check-in timing and Flyo's journey rules
4. It chases the traveller on WhatsApp for whatever is missing.
5. It sends Flyo a **full** passenger `update` (with the scans attached) only once the traveller is actually ready to fly. If there's a blocking problem, the completing update is held and the agent is alerted.
6. It follows the check-in through webhooks plus status polling, and delivers the boarding passes on WhatsApp.

## Run it

Requires Node 20+.

```powershell
npm install
npm start          # mock Flyo API on :4010 + dashboard on http://127.0.0.1:3000
```

Open http://127.0.0.1:3000 and click a demo ticket. Then use the **Send as traveller** chips in the phone panel to send sample passports and visas.

| Demo ticket | What it shows |
|---|---|
| Goa family (domestic, return) | Round trip split into two one-way check-ins; asks for an email; 4 boarding passes |
| London via Dubai | UK visa required; the "blurry passport" sample fails its MRZ check digits; the update is held until the visa arrives |
| Bangkok | Old passport fails Thailand's 6-month rule (red, agent alerted); the renewed passport passes with a middle-name note; TDAC reminder |
| New York via London | US visa required, UK DATV needed in transit; sending the US visa clears both |

Pasted ticket text with `PNR: FAILED` makes the mock fail the check-in, so you can see failure handling.

Other commands: `npm run reset` wipes local state (stop the servers first). `npm run samples` writes the ticket PDFs and document images to `samples-out/` so you can drag and drop them.

## Configuration (`.env`, see `.env.example`)

- **Real Flyo:** set `FLYO_BASE_URL` (provided by your Flyo account manager) and `FLYO_API_KEY`, then run `node src/app/server.mjs`. `APP_PUBLIC_URL` must be reachable by Flyo for webhooks; polling covers you when it isn't.
- **Vision LLM** (real ticket photos and passport photos): set `LLM_PROVIDER` (`gemini`, `openai` or `anthropic`) and `LLM_API_KEY`. Without one, PDFs and pasted text go through the built-in parser, and the bundled sample documents are read from their text layer.
- **Real WhatsApp:** set `MESSAGING=twilio` and the Twilio sandbox credentials. Point the sandbox webhook at `<APP_PUBLIC_URL>/webhooks/twilio`; the Twilio signature is verified.

## How it follows Flyo's documented contract

- Flight times are sent as airport-local wall clock with no offset. `requests` summaries are read with the legacy `Z` suffix stripped, not treated as UTC.
- Journey rules are checked locally before `subscribe` so no quota is spent on a guaranteed 422: one-way, single airline, connected legs, no revisits, at least 6 hours before departure. Round trips become separate one-way subscriptions.
- `update` is always a complete passenger list. Files are re-attached through matching `file_field` parts, because the API doesn't return storage URLs.
- Webhooks are checked against the registered `auth_header`, de-duplicated by `event_id`, and acknowledged immediately. Snapshots older than the current state are ignored, and each webhook is reconciled with `status`.
- No resubscribe loops. After a 500 or timeout, the app reconciles through `status` / `requests`. A 409 stops further updates and re-reads status. On 422 `DEPARTURE_TOO_CLOSE` after an update, the app assumes the changes were saved and flags a manual check-in. On 429, it waits `retryAfter`.
- `COMPLETED` with no boarding passes is shown as "checked in, pass pending". Passes are a flat array and are not mapped to passengers.

The mock (`src/mock-flyo`) implements these behaviours too: missing info, duplicates, `AIRLINE_MISMATCH`, `NOT_UPDATABLE`, multipart binding, pagination, legacy routes, webhooks with retries and duplicate delivery. Anything the public docs don't specify is a guess: internal `sub_status` names, the other reason codes, and per-airline check-in windows.

## Caveats

- Entry and transit rules are a small, simplified dataset for **Indian passport holders**. They are not legal advice, and production would use IATA Timatic or a similar source.
- The dashboard has **no login** and binds to 127.0.0.1. Don't expose it as-is.
- All people, documents and numbers in the samples are fictitious.
