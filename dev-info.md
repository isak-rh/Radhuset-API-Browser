*The English version of this document follows below.*

---

# Information för administratörer och utvecklare

## Var data lagras

Appen är en statisk webbsida — det finns ingen server eller databas. Allt som sparas ligger i webbläsarens `localStorage`, per webbläsare och enhet, under dessa nycklar:

| Nyckel | Innehåll |
| --- | --- |
| `customApis` | Dina egna tillagda API:er, i samma format som `config/apis.json`. |
| `bindings` | Vilken auth-profil som är kopplad till vilket API. |
| `vault` | Sparade inloggningsuppgifter, krypterade (se nedan). |
| `prefs` | Inställningar som tema. |
| `language` | Valt språk för gränssnittet. |

Export/import-funktionen i inställningarna samlar allt detta i en enda JSON-fil, med sparade uppgifter alltid krypterade under ett lösenord du väljer vid export.

## Interna konfigurationsfiler

### `config/apis.json`

Listan över inbyggda API:er. Distribueras med appen och innehåller ingen användardata — redigera den och pusha för att ändra vad som finns med som standard för alla användare. Varje post:

```json
{
  "name": "Exempel-API",
  "url": "https://exempel.se/stac/v1/",
  "api_type": "stac",
  "auth_required": "download",
  "schema_url": "https://exempel.se/schema.json",
  "schema_query_depth": 10
}
```

`api_type` är `stac` eller `ngp`. `auth_required` är `none`, `download` eller `all` (NGP-API:er kräver alltid `all`, oavsett vad som anges). `schema_url` och `schema_query_depth` gäller bara NGP-API:er och styr Query Builder.

## Koordinatsystem

Kartan är Web Mercator (EPSG:3857) över OpenStreetMap, och varje sökområde och resultat hanteras internt som WGS 84 (EPSG:4326) longitud/latitud.

STAC-API:er frågas i WGS 84 enligt specifikationen. Lantmäteriets NGP-API:er använder SWEREF 99 TM som standard och följer inte STAC-specifikationens antagande om WGS 84, så sökningar mot dem anger uttryckligen OGC-koden `CRS84` via query-parametrarna `bbox-crs` och `crs`, vilket ber NGP att acceptera och returnera koordinater i WGS 84 i stället. (`EPSG:4326` används medvetet inte här — OGC API Features ger den koden latitud/longitud-ordning, så samma siffror skulle betyda en annan plats; `CRS84` är samma datum i den konventionella longitud/latitud-ordningen.) Inlästa filer i andra koordinatsystem (SWEREF 99, RT 90, UTM …) projiceras om till WGS 84 vid inläsning, utläst från filens egna CRS-metadata (en Shapefils `.prj`, en GeoPackages SRS-tabell, eller GeoJSON:s äldre `crs`-medlem).

## Inloggningsuppgifter och säkerhet

Inget härifrån skickas någonstans förutom de API:er och OAuth2-token-endpoints du själv konfigurerar — det finns ingen serverkomponent alls.

- Uppgifter som bara gäller **den öppna fliken** ligger i minnet så länge fliken är öppen och skrivs aldrig till disk.
- **Sparade** uppgifter krypteras i `localStorage` med AES-256-GCM. Nyckeln härleds från ett huvudlösenord du väljer via PBKDF2-SHA256 (600 000 iterationer); själva lösenordet sparas aldrig. Glömmer du det går sparade profiler inte att återställa — det finns medvetet ingen återställningsväg.
- Som alternativ kan en **passkey** (via enhetens skärmlås, en telefon eller en säkerhetsnyckel) låsa upp valvet i stället för att skriva lösenordet, via WebAuthn PRF-tillägget. Stödet varierar mellan webbläsare och autentiseringsmetoder och avgörs vid körning; där det inte finns visas alternativet helt enkelt inte, och huvudlösenordet fungerar alltid som reserv.
- OAuth2-access-tokens cachas bara i minnet, kopplade till exakt de uppgifter som hämtade dem, och sparas aldrig.
- Export av inställningar med sparade profiler krypterar dem separat, under ett lösenord du väljer vid export (som kan vara samma som huvudlösenordet eller ett annat) — den exporterade filen innehåller aldrig okrypterade uppgifter.

## Nedladdningar i bulk

Den bästa upplevelsen är i en Chromium-baserad webbläsare med File System Access API: välj en mapp en gång, så strömmas varje fil direkt dit, återupptagningsbart mellan omgångar (filer som redan finns med matchande namn och storlek hoppas över). Stödet kontrolleras vid körning, inte utifrån webbläsarens namn — finns det inte går nedladdningar i stället via webbläsarens egen nedladdningsfunktion, antingen som en enda ZIP-fil eller som separata filer, med en förklarande notis.

## Webbläsarstöd

Byggd för aktuell Chromium, Firefox och Safari. Nedladdningar i bulk fungerar bäst i Chromium; alla andra funktioner fungerar likadant överallt där modern JavaScript körs. Det finns inget stöd för Internet Explorer eller andra webbläsare från före 2020.

## Köra och bygga från källkod

Det här är en statisk sida utan byggsteg. Servera repots rotmapp med valfri statisk filserver och öppna den:

```sh
python -m http.server 8000
# eller: npx http-server -p 8000
```

Besök sedan `http://localhost:8000/`. Filer som laddas via `fetch()` (`config/apis.json`, de medföljande biblioteken) fungerar inte över `file://`, så en riktig HTTP-server — även en trivial lokal sådan — krävs.

### Tester

Enhetstester för den rena logiken (kryptering, STAC-klienten, koordinatprojicering, filnamnshantering, schema-scannern…) ligger i `tests/` och körs i webbläsaren själv, mot mockade nätverksanrop. Servera rotmappen som ovan och öppna `/tests/`.

### Projektstruktur

```
index.html          startsida
src/
  app.js             applikationens tillstånd och åtgärder
  auth/              det krypterade valvet, profiler, OAuth2-sessioner, passkeys
  config/            API-registret (inbyggt + användartillagt)
  downloads/         filnamn, mapp/ZIP/webbläsar-nedladdningsmålen, batch-körningen
  geo/               sökområdesgeometri, CRS-projicering, filinläsare (GeoJSON/Shapefile/GeoPackage)
  lib/               små ramverksfria hjälpfunktioner (DOM, HTTP, lagring, formatering)
  map/               OpenLayers-kartomslaget
  stac/              STAC/NGP-klienten och NGP-schemascannern
  ui/                dialoger och paneler, kopplade till app.js
  styles/app.css     hela stilmallen
config/apis.json     listan över inbyggda API:er (distribueras; ingen användardata)
vendor/              vendorade tredjepartsbibliotek — se THIRD-PARTY-NOTICES.md
assets/              ikon, logotyp, typsnittet Figtree
tests/               enhetstester som körs i webbläsaren
```

### Publicering

En push till `main` publicerar sidan via GitHub Actions (`.github/workflows/pages.yml`) till GitHub Pages — aktivera Pages för repot (Settings → Pages → Source: GitHub Actions) så publiceras nästa push automatiskt. Det finns inget byggsteg: workflowet kopierar bara de filer sidan faktiskt behöver (`index.html`, `assets/`, `config/`, `src/`, `vendor/`) till den publicerade sidan.

## Bidra

Vi planerar för närvarande inte att ta emot bidrag till källkoden men det kan ändras beroende på intresset. Du får gärna skapa en issue om du har förslag eller buggar.

---

# Information for admins and developers

## Where data is stored

The app is a static web page — there is no server or database. Everything saved lives in the browser's `localStorage`, per browser and device, under these keys:

| Key | Contents |
| --- | --- |
| `customApis` | Your own added APIs, in the same format as `config/apis.json`. |
| `bindings` | Which auth profile is bound to which API. |
| `vault` | Saved credentials, encrypted (see below). |
| `prefs` | Preferences such as theme. |
| `language` | The UI's selected language. |

The export/import feature in settings bundles all of this into a single JSON file, with saved credentials always encrypted under a password you choose at export time.

## Internal configuration files

### `config/apis.json`

The list of built-in APIs. Shipped with the app and holds no user data — edit it and push to change what's offered by default to every user. Each entry:

```json
{
  "name": "Example API",
  "url": "https://example.com/stac/v1/",
  "api_type": "stac",
  "auth_required": "download",
  "schema_url": "https://example.com/schema.json",
  "schema_query_depth": 10
}
```

`api_type` is `stac` or `ngp`. `auth_required` is `none`, `download` or `all` (NGP APIs always require `all`, regardless of what's set). `schema_url` and `schema_query_depth` only apply to NGP APIs and drive the Query Builder.

## Coordinate systems

The map is Web Mercator (EPSG:3857) over OpenStreetMap, and every search area and result is handled internally as WGS 84 (EPSG:4326) longitude/latitude.

STAC APIs are queried in WGS 84 per the spec. Lantmäteriet's NGP APIs default to SWEREF 99 TM and don't follow the STAC spec's WGS 84 assumption, so searches against them explicitly advertise the OGC `CRS84` code via the `bbox-crs` and `crs` query parameters, which asks NGP to accept and return coordinates in WGS 84 instead. (`EPSG:4326` is deliberately not used for this — OGC API Features gives that code latitude/longitude axis order, so the same numbers would mean a different place; `CRS84` is the same datum in the conventional longitude/latitude order.) Loaded files in other coordinate systems (SWEREF 99, RT 90, UTM …) are reprojected to WGS 84 on load, read from the file's own CRS metadata (a Shapefile's `.prj`, a GeoPackage's SRS table, or GeoJSON's legacy `crs` member).

## Credentials & security

Nothing here is sent anywhere except the APIs and OAuth2 token endpoints you configure — there is no server component to this app at all.

- **Session-only** credentials live in memory for as long as the tab is open and are never written to disk.
- **Saved** credentials are encrypted at rest in `localStorage` with AES-256-GCM. The key is derived from a master password you choose via PBKDF2-SHA256 (600,000 iterations); the password itself is never stored. Losing it means the saved profiles can't be recovered — there is no reset path by design.
- Optionally, a **passkey** (through your platform's screen lock, a phone, or a security key) can unlock the vault instead of typing the password, via the WebAuthn PRF extension. Support varies by browser and authenticator and is detected at runtime; where it isn't available the option is simply not offered, and the master password always keeps working as a fallback.
- OAuth2 access tokens are cached in memory only, keyed to the exact credentials that obtained them, and are never persisted.
- Exporting settings with saved profiles included encrypts them separately, under a password you choose at export time (which can be the same as your master password or a different one) — the exported file never contains plaintext credentials.

## Batch downloads

The best experience is in a Chromium-based browser with the File System Access API: pick a folder once, and every asset streams straight into it, resumable across a batch (files already present with a matching name and size are skipped). Support is checked at runtime, not assumed from the browser — if it isn't available, downloads instead go through the browser's own download mechanism, either as a single ZIP or as separate files, with a notice explaining why.

## Browser support

Built for current Chromium, Firefox and Safari. Batch downloads work best in Chromium; every other feature works the same everywhere modern JavaScript runs. There is no support for Internet Explorer or other pre-2020 browsers.

## Running and building from source

This is a static site with no build step. Serve the repository root with any static file server and open it:

```sh
python -m http.server 8000
# or: npx http-server -p 8000
```

Then visit `http://localhost:8000/`. Files loaded via `fetch()` (`config/apis.json`, the vendored libraries) don't work over `file://`, so a real HTTP server — even a trivial local one — is required.

### Tests

Unit tests for the pure logic (crypto, the STAC client, coordinate reprojection, filename handling, the schema scanner…) live in `tests/` and run in the browser itself, against mocked network calls. Serve the repo root as above and open `/tests/`.

### Project layout

```
index.html          entry point
src/
  app.js             application state and the actions on it
  auth/              the encrypted vault, profiles, OAuth2 sessions, passkeys
  config/            the API registry (built-in + user-added)
  downloads/         filenames, the folder/ZIP/browser download targets, the batch runner
  geo/               search-area geometry, CRS reprojection, file loaders (GeoJSON/Shapefile/GeoPackage)
  lib/               small framework-free helpers (DOM building, HTTP, storage, formatting)
  map/               the OpenLayers map wrapper
  stac/              the STAC/NGP client and the NGP schema scanner
  ui/                dialogs and panels, wired to app.js
  styles/app.css     the whole stylesheet
config/apis.json     the built-in API list (deploy-managed; no user data)
vendor/              vendored third-party libraries — see THIRD-PARTY-NOTICES.md
assets/              icon, logo, Figtree font files
tests/               in-browser unit tests
```

### Deploying

Pushing to `main` publishes the site via GitHub Actions (`.github/workflows/pages.yml`) to GitHub Pages — enable Pages for the repository (Settings → Pages → Source: GitHub Actions) and it deploys on the next push. There's no build step: the workflow just copies the files the page actually needs (`index.html`, `assets/`, `config/`, `src/`, `vendor/`) into the published site.

## Contribute

We are currently not planning to accept contributions to the source code, but that may change depending on interest. Feel free to open an issue if you have suggestions or bugs.
