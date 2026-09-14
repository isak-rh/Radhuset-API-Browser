[Klicka här för att öppna appen på GitHub Pages / Click here to open the app on GitHub Pages](https://isak-rh.github.io/Radhuset-API-Browser/)

*The English version of this document follows below.*

---

<img width="300" alt="Rådhuset Arkitekters logotyp" src="assets/radhuset-logo.svg" />

# Rådhuset API Browser

Den här applikationen har utvecklats av **Rådhuset Arkitekter** efter att Lantmäteriet 2025 släppte sina så kallade värdefulla datamängder (High Value Datasets, HVD). Vi såg enorma möjligheter med datamängderna, men var missnöjda med hur svåråtkomliga de var och med de befintliga verktygen för STAC-API:er. Vi ville dessutom komma åt NGP, Nationella geodataplattformen, som det inte fanns några lämpliga verktyg alls för.

Vi skapade därför ett enkelt webbverktyg för att bläddra i och ladda ner svenska kartdata, byggt kring Lantmäteriets STAC- och NGP-API:er. Det körs helt i webbläsaren, utan installation.

Tre saker skiljer den från andra STAC-klienter:

- **Ladda ner i bulk.** Kryssa i valfritt antal sökträffar och ladda ner alla deras filer på en gång. Grafiska STAC-klienter låter dig i regel granska enskilda objekt, men inte ladda ner flera åt gången.
- **Stöd för NGP.** Lantmäteriets NGP-API:er är en äldre avknoppning av STAC som avviker från specifikationen på några punkter, framför allt genom att använda SWEREF 99 som standard. Standardklienter som STAC Browser fungerar inte korrekt med NGP.
- **Sparade inloggningsuppgifter.** STAC Browser, den rekommenderade metoden för att bläddra i Lantmäteriets API:er, kräver att du kommer ihåg och matar in uppgifterna till ditt Lantmäteriet-administratörskonto varje gång du laddar ner något. Den här applikationen kan spara dina uppgifter, med krypterad lagring på din egen dator, och gör det möjligt att använda den säkrare OAuth2-metoden.

---

## Komma igång

Öppna appens webbadress i din webbläsare - använd antingen [vår egen distribution på Github Pages,](https://isak-rh.github.io/Radhuset-API-Browser/) eller ladda ner källkoden och hosta din egen. Inget behöver installeras, och inget skickas till någon server förutom de API:er du själv väljer att använda.

Som standard kan du bläddra i Lantmäteriets STAC-API:er men inte ladda ner filer. Nedladdningar, och all åtkomst till NGP-API:er, kräver inloggningsuppgifter. För Lantmäteriet använder du [Geotorget](https://geotorget.lantmateriet.se/) för att begära åtkomst och grundläggande uppgifter, och [API-portalen](https://apimanager.lantmateriet.se/devportal/apis) för att sätta upp OAuth2-uppgifter. När du har dina uppgifter öppnar du **Manage auth profiles…** i panelen till vänster (🔑-knappen under Auth profile), skapar en **Basic**-profil (användarnamn + lösenord) eller en **OAuth2**-profil (klient-ID, klienthemlighet, token-URL) och väljer den för varje API som ska använda den.

Du väljer själv om varje uppgift bara ska gälla för den öppna fliken (och alltså försvinner när du stänger den), eller sparas i webbläsaren till nästa gång. Om du väljer att spara den krypteras den och lagras enbart på din egen enhet — vi ser den aldrig, och den skickas aldrig någon annanstans än till det API du använder den med. Eftersom uppgifterna bara finns lokalt hos dig går de inte att komma åt från en annan dator eller webbläsare, och de försvinner om du rensar webbläsarens lagring. 

Vi rekommenderar OAuth2-uppgifter, eftersom de går att återkalla och inte ger administratörsåtkomst till ditt konto hos Lantmäteriet, till skillnad från användarnamn och lösenord.

---

## Grundläggande användning

Välj ett API, markera ut ett område på kartan, sök och ladda ner det du hittar. Sökområdet kan ritas som en box eller polygon, eller läsas in från en fil (GeoJSON, Shapefile eller GeoPackage). Kryssa i de sökträffar du vill ha och tryck **Download selected**.

När du bläddrar i NGP-API:er rekommenderas att du använder **Query Builder** för att begränsa dina sökningar till den typ av data du letar efter. Nedladdningar från NGP levereras i de format som Lantmäteriet anger.

Högerklicka på ett objekt och välj **Properties** för att öppna panelen med detaljerad information om det markerade objektet. Detta är särskilt användbart när man bläddrar i NGP.

I en Chromium-baserad webbläsare (Chrome, Edge, Opera, Brave …) väljer du en mapp en gång, och alla filer i nedladdningen sparas direkt dit. I andra webbläsare laddas filerna i stället ner som en ZIP-fil eller separata filer, på det sätt webbläsaren normalt hanterar nedladdningar.

---

## Information för administratörer och utvecklare

Teknisk information om konfiguration och hur du själv använder källkoden hittar du i [dev-info.md.](dev-info.md)

---

## Juridisk information

### Licens

Rådhuset API Browser är fri programvara som licensieras under **GNU General Public License, version 3 eller senare**. Det innebär att du fritt får använda, studera, ändra och dela den. Den tillhandahålls i befintligt skick, utan någon garanti — som med all fri programvara innebär det att du använder den på egen risk. Se [LICENSE](LICENSE) för den fullständiga licenstexten.

### Tredjepartskomponenter

Applikationen använder OpenLayers, proj4js, fflate, sql.js och typsnittet Figtree, som alla medföljer med öppen källkod. De är förtecknade i [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Kartunderlaget kommer från OpenStreetMap, © OpenStreetMap contributors, under Open Database License. Geodata som hämtas via appen omfattas av villkoren för respektive API.

---

<img width="300" alt="Logo of Rådhuset Arkitekter" src="assets/radhuset-logo.svg" />

# Rådhuset API Browser

This application was developed by **Rådhuset Arkitekter** after the 2025 release of High Value Datasets (HVD) by Lantmäteriet. We saw enormous opportunity in the datasets, but were dissatisfied with how difficult it was to access and the state of the current tools for STAC APIs. We also wanted to access NGP, the National Geodata Platform, for which there were no suitable tools at all.

We thus created a simple web-based tool for browsing and downloading Swedish map data, built around Lantmäteriet's STAC and NGP APIs. It runs entirely in the browser, with nothing to install.

Three things set it apart from other STAC clients:

- **Bulk downloads.** Tick any number of search results and download all of their files in one go. Graphical STAC clients generally let you inspect items but not download them in bulk.
- **NGP support.** Lantmäteriet's NGP APIs are an older offshoot of STAC that departs from the spec in a few ways, in particular by using SWEREF 99 as default. Standard clients like STAC Browser do not work properly with NGP.
- **Saved credentials.** STAC Browser, the recommended method for browsing the Lantmäteriet APIs, requires you to remember and input your Lantmäteriet admin account credentials every time you download something. This application can save your credentials, with encrypted storage on your own device, and allows for using the safer OAuth2 method.

---

## Setting up

Open the app's web address in your browser - either use [our own deployment on GitHub Pages,](https://isak-rh.github.io/Radhuset-API-Browser/) or download the source code and host your own. Nothing needs to be installed, and nothing is sent to any server except the APIs you choose to use.

By default, you can browse the Lantmäteriet STAC APIs but not download files. Downloads, and any access to NGP APIs, require credentials. For Lantmäteriet, you use [Geotorget](https://geotorget.lantmateriet.se/) to request access and basic credentials, and [API-Portalen](https://apimanager.lantmateriet.se/devportal/apis) to set up OAuth2 credentials. Once you have credentials, open **Manage auth profiles…** in the left-hand panel (the 🔑 button under Auth profile), create a **Basic** (username + password) or **OAuth2** (client ID, client secret, token URL) profile, and select it for each API that should use it.

You choose whether each credential applies only to the current tab (and disappears once you close it), or is saved in the browser for next time. If you choose to save it, it's encrypted and stored only on your own device — we never see it, and it's never sent anywhere except to the API you're using it with. Because it only ever lives locally, it isn't accessible from another computer or browser, and it's lost if you clear the browser's storage. 

We recommend OAuth2 credentials, since they are revokable and don't provide admin access to your Lantmäteriet account, unlike the basic credentials.

---

## Basic use

Pick an API, mark out an area on the map, search, and download what you find. The search area can be drawn as a box or polygon, or loaded from a file (GeoJSON, Shapefile or GeoPackage). Tick the results you want and press **Download selected**.

When browsing NGP APIs, it is recommended to use the **Query Builder** in order to limit your searches to the type of data you are looking for. Downloads from NGP are delivered in the formats specified by Lantmäteriet.

Right-click an item and select **Properties** to open the panel with detailed information about the highlighted item. This is particularly useful when browsing NGP.

In a Chromium-based browser (Chrome, Edge, Opera, Brave …), you pick a folder once, and every file in the download is saved straight into it. In other browsers, files are instead downloaded as a ZIP file or as separate files, the way the browser normally handles downloads.

---

## Information for admins and developers

Technical information about configuration and how to use the source code yourself can be found in [dev-info.md.](dev-info.md)

---

## Legal notices

### License

Rådhuset API Browser is free software, licensed under the **GNU General Public License, version 3 or later**. That means you're free to use, study, modify and share it. It is provided as-is, without any warranty — as with any free software, that means using it at your own risk. See [LICENSE](LICENSE) for the full license text.

### Third-party components

The application uses OpenLayers, proj4js, fflate, sql.js and the Figtree typeface, all bundled as open source. They are inventoried in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The base map uses OpenStreetMap tiles, © OpenStreetMap contributors, under the Open Database License. Geodata retrieved through the app is subject to the terms of whichever API it came from.
