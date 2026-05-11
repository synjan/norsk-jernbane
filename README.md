# Norsk jernbane — kart, sanntid og innsikt

> 🌐 **Live: [synjan.github.io/norsk-jernbane](https://synjan.github.io/norsk-jernbane/)**

Interaktivt kart over norsk jernbane med:

- Alle spor, stasjoner og holdeplasser (fra OpenStreetMap)
- Sanntids togposisjoner og avganger (fra Entur)
- Statistikk om elektrifisering, tunneler, broer, fart, dobbeltspor
- Egen side per bane og per stasjon med bilder og historikk

Alt er åpne data. Alt kjører i nettleseren. Live-siden oppdateres automatisk når noe endres — og dataene refreshes fra OSM, Wikidata og NVDB én gang i måneden helt på egenhånd.

---

## 🗺 Hvis du bare vil se kartet

Åpne **[synjan.github.io/norsk-jernbane](https://synjan.github.io/norsk-jernbane/)**.

Du trenger ikke installere noe. Det fungerer på telefon, nettbrett og PC.

---

## 💬 Hvis du vil endre på prosjektet

**Du trenger ikke skrive kode.** Du beskriver hva du vil ha på vanlig norsk til en AI-assistent — den gjør resten.

Det finnes to AI-assistenter som passer godt:

- **GitHub Copilot** — innebygget i VS Code. Chat-vinduet kan endre filer for deg.
- **Claude Code** — egen app fra Anthropic. [Last ned her](https://claude.com/claude-code).

Begge kan brukes — Claude Code er litt sterkere på større oppgaver, Copilot integrerer godt med VS Code hvis du allerede bruker det.

---

## 🎙 Hvordan snakke med AI-en

### Eksempler på ting du kan be om

| Du vil... | Si noe sånt som... |
|-----------|----------------|
| Endre tekst på en side | *"Endre tittelen på dashbordet til 'Jernbane-innsikt'"* |
| Endre farger | *"Endre stasjons-markørene fra blå til mørkegrønn"* |
| Legge til en ny statistikk | *"Legg til 'lengste tunnel-segment' på innsikt-siden"* |
| Fikse en feil du ser | *"Når jeg klikker på Bergensbanen-popupen viser den feil bane. Fiks det."* |
| Forstå hva noe gjør | *"Forklar hvordan live-tog-animasjonen fungerer"* |
| Oppdatere data | *"Hent fersk jernbanedata fra OpenStreetMap"* |
| Publisere endringer | *"Test at alt fungerer og publiser til live-siden"* |
| Lage en ny side | *"Lag en ny side som viser alle planoverganger på et kart"* |
| Stille et spørsmål til dataene | *"Hvilken bane har flest tunneler?"* |

### Tips for å få det du vil ha

1. **Vær konkret.** *"Endre stasjons-markørene fra blå til mørkegrønn"* er bedre enn *"fiks fargene"*.
2. **Beskriv hva du SER, ikke hva du tror er galt.** *"Popupen viser '4. lengste' selv om jeg står på Bergensbanen"* er mer nyttig enn *"rangen er feil"*.
3. **Be om forklaring først hvis du er usikker.** *"Forklar hva du vil gjøre før du endrer noe."*
4. **Én ting om gangen.** Lettere å sjekke resultatet, lettere å rulle tilbake hvis du angrer.
5. **Test live-siden etter publisering.** Åpne live-URL-en i en annen fane, hard-refresh (Ctrl+Shift+R), og sjekk at endringen din vises.

---

## 🤖 Hva AI-en gjør for deg automatisk

Du trenger ikke tenke på dette — AI-en håndterer det:

- 🔍 Lete i koden for å finne riktig sted å endre
- ✏️ Gjøre selve endringene
- 🧪 Kjøre automatiske tester for å sjekke at ingenting brøt
- 💾 Lagre endringene (git)
- 🚀 Publisere til live-siden (tar ~30 sek etter at AI har lagret)
- 📊 Hente og oppdatere data fra OpenStreetMap, Entur, Wikidata når du ber om det

## 🙋 Det du må gjøre selv

- ✅ Beskriv hva du vil ha
- ✅ Si ja eller nei når AI spør om bekreftelse på større endringer
- ✅ Sjekk live-siden etter publisering for å være sikker på at det ble som du tenkte
- ✅ Si fra hvis det ikke ble riktig — AI kan justere eller rulle tilbake

---

## 🐛 Når noe er rart

Be AI-en undersøke. Konkrete prompts som hjelper:

- *"Live-siden viser fortsatt det gamle — sjekk om endringen er publisert"*
- *"[X] krasjer når jeg gjør [Y]. Finn ut hvorfor og fiks det."*
- *"Tallene på dashbordet ser feil ut. Sammenlign med stats.json og finn årsaken."*
- *"Stasjoner vises på feil sted på kartet — er det data-feil eller kode-feil?"*

Du kan også åpne nettleserens konsoll (F12 → Console-fanen) og kopiere feilmeldingen inn i AI-chat-en — den forteller AI-en mye om hva som er galt.

---

## 🗃 Datakilder

Alle data er åpne og kan brukes — kildene har bare ulike attribusjons-krav. AI-en kjenner til kildene og håndterer attribusjonen.

| Kilde | Hva |
|-------|-----|
| **OpenStreetMap** | Spor, stasjoner, signaler, sporveksler |
| **Entur** | Togavganger og sanntids togposisjoner |
| **Wikidata** | Bilder, åpningsår, arkitekter, fredning |
| **Statens vegvesen NVDB** | Jernbanekryssinger |

---

## 📚 For AI-assistenter (teknisk)

Hvis du er en AI som leser dette: hovedkonteksten ligger i to filer:

- [`CLAUDE.md`](CLAUDE.md) — invarianter, navnekonvensjoner, hvor logikk bor
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — modulkart og data-flyt

Hvis brukeren beskriver en feil eller ny feature, sjekk disse først for kontekst.

---

## 🆘 Hvis AI-en står fast

Hvis AI-en ikke skjønner hva du vil eller gjentar samme feil:

- **Beskriv på nytt med flere detaljer**: hvor på siden, hva du gjorde, hva du forventet, hva som faktisk skjedde
- **Ta et skjermbilde** og lim det inn i chat-en (begge AI-ene støtter dette)
- **Be om at den leser `CLAUDE.md` først**: *"Les CLAUDE.md først for prosjekt-kontekst, så fiks dette"*
- **Bytt assistent** — hvis Copilot står fast, prøv Claude Code, eller omvendt

---

## 📬 Bug-rapporter og spørsmål

Opprett en [issue på GitHub](https://github.com/synjan/norsk-jernbane/issues) — eller bare be AI-en gjøre det for deg.
