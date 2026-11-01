# Matching Tool Community

**Buchhaltungs- und Abstimmungssoftware für einfache Konten und komplexe Geldflüsse.**

Matching Tool Community führt Buchungen, Rechnungen und Belege in einer lokalen Anwendung zusammen. Es hilft dabei, Einnahmen und Ausgaben zu erfassen, Zahlungen den richtigen Belegen zuzuordnen und Geldbewegungen zwischen mehreren Konten nachvollziehbar zu machen. Automatische Belegerkennung, Zuordnungsvorschläge und unterstützte Rechnungsbeschaffung nehmen wiederkehrende Arbeit ab; die fachliche Prüfung und Bestätigung bleiben beim Nutzer.

Das funktioniert für ein einzelnes Bankkonto ebenso wie für eine Kombination aus Bankkonten, Kreditkarten, PayPal, Stripe und verschiedenen Währungen. Im Mittelpunkt steht die Frage: **Woher kommt das Geld, wohin geht es – und welcher Beleg gehört dazu?**

## Warum ein reines Einnahmen-Ausgaben-Verzeichnis oft nicht reicht

Eine Zahlung kann mehrere Stationen durchlaufen, bevor sie auf dem Bankkonto ankommt. Zahlungsanbieter ziehen Gebühren ab, bündeln mehrere Verkäufe zu einer Auszahlung oder verrechnen Rückerstattungen. Dazu kommen Umbuchungen, Teilzahlungen und Fremdwährungen.

Ein vereinfachtes, fiktives Beispiel:

| Vorgang | Betrag | Bedeutung für die Abstimmung |
|---|---:|---|
| Kunde bezahlt über PayPal | 100,00 EUR | Verkauf mit zugehörigem Beleg |
| PayPal behält eine Gebühr ein | −3,00 EUR | Eigener Gebührenposten |
| PayPal zahlt auf das Bankkonto aus | 97,00 EUR | Geldbewegung zwischen den eigenen Konten |

Die Auszahlung ist kein zweiter Verkauf. Das Tool unterstützt dabei, Verkauf, Gebühr und Auszahlung getrennt zu erfassen und miteinander zu verknüpfen. Bei Sammelauszahlungen können mehrere Vorgänge zu einer Auszahlung gehören. Die bestätigten Zuordnungen und Klassifikationen bilden anschließend die Grundlage der Auswertungen.

## Was das Programm bietet

### Mehrere Konten und Zahlungsquellen zusammenführen

- Buchungen nach Konto, Zahlungsquelle, Zeitraum und Suchbegriff überblicken.
- Kontoauszüge über eine Vorschau prüfen und anschließend ausdrücklich importieren; CSV-/XLSX-Import für die unterstützten Sparkasse-/Visa-Formate.
- PayPal- und Stripe-Buchungen über selbst eingerichtete, lesende API-Verbindungen synchronisieren.
- Unterstützte Bankinformationen über eine selbst autorisierte Enable-Banking-AIS-Verbindung abrufen.
- Ursprüngliche Konto- und Quellenkennungen erhalten sowie Duplikate und widersprüchliche Importe erkennen.

Die Verbindungen benötigen eigene, berechtigte Anbieterzugänge. Die Verfügbarkeit beim jeweiligen Anbieter wird durch die lokalen Softwaretests nicht zugesichert.

### Buchungen und Belege abstimmen

„Matching“ bedeutet hier: Buchungen, Belege und zusammengehörige Geldbewegungen miteinander verknüpfen.

- Automatische Zuordnungsvorschläge prüfen, annehmen, ablehnen oder manuell ergänzen.
- Einzelzuordnungen, Teilzahlungen und Aufteilungen auf mehrere Buchungen oder Belege abbilden.
- Rückerstattungen, Gutschriften, Gebühren und interne Umbuchungen unterscheiden.
- Anbieter-Auszahlungen und ihre Gegenbuchungen auf dem Bankkonto nachvollziehen.
- Fremdwährungszuordnungen mit ausdrücklich angegebenem Wechselkurs und Nachweis bearbeiten.
- Private und ausgeschlossene Vorgänge sichtbar kennzeichnen, Regeln verwalten und Zuordnungen bei Bedarf wieder öffnen oder rückgängig machen.

Ein Vorschlag ist noch keine bestätigte Buchhaltungsgrundlage. Offene Beträge und ungeklärte Zuordnungen bleiben zur Prüfung sichtbar.

### Belege automatisch erkennen und prüfen

PDFs und Bilder lassen sich als Belege erfassen. Die lokale Texterkennung unterstützt Deutsch und Englisch. Erkannte Angaben werden für die weitere Bearbeitung aufbereitet und können korrigiert werden, bevor ein Beleg bestätigt wird.

Das umfasst unter anderem Rechnungsnummern, Lieferanten, Datumsangaben, Beträge, Währungen und Steuerangaben. Rechnungen und ausdrückliche Gutschriften werden getrennt behandelt. Originaldateien, Prüfsummen und die dokumentierte Bearbeitungshistorie bleiben erhalten.

Die Erkennung unterstützt die Erfassung; sie ersetzt nicht die Prüfung des Originals. Fehlende oder unsichere Angaben werden nicht allein durch einen passenden Betrag zu bestätigten Nachweisen.

### Rechnungen beschaffen und zentral ablegen

Der Rechnungsbot unterstützt den Weg vom Anbieterportal zum prüfbaren Beleg. Im aktuellen Community-Stand öffnet er eine separate Browsersitzung. Der Nutzer meldet sich selbst an, lädt verfügbare Rechnungen herunter und wählt die Dateien zur Übernahme aus. Die Anwendung erkennt abgeschlossene Downloads, übernimmt die ausgewählten Dateien und führt sie dem Belegprozess zu.

Vorhanden sind elf unterstützte Portal-Einträge: Amazon Business, OpenAI Platform, ChatGPT, Google Cloud, Google One, Spotify, Fiverr, Post-Bestellungen, Post ELLA, Bambu Lab EU und AliExpress.

**Die derzeitige Rechnungsbeschaffung ist assistiert.** Ein allgemeiner, vollständig unbeaufsichtigter Abruf einschließlich Anmeldung und Kontowahl ist nicht aktiviert. Bei AliExpress kann zusätzlich eine ausdrücklich ausgewählte Bestellansicht als unbestätigter Belegnachweis erfasst werden; sie gilt dadurch nicht automatisch als steuerliche Rechnung. Details stehen im [Verzeichnis der Anbieterabläufe](docs/feature-parity/INVOICE_PORTAL_INVENTORY.md).

### Auswerten und für die weitere Buchhaltung exportieren

- Einnahmen, Ausgaben, Gebühren, Rückerstattungen, Transfers und private Vorgänge getrennt auswerten.
- Offene und zugeordnete Beträge sowie den Stand der Abstimmung nachvollziehen.
- Berichte für einen ausdrücklich ausgewählten Zeitraum erstellen.
- Währungen getrennt führen; EUR und USD werden nicht ohne begründete Umrechnung zu einer Summe addiert.
- Geprüfte Steuerklassifikationen und Umsatzsteuerbeträge anhand bestätigter Nachweise auswerten.
- Ergebnisse als CSV oder JSON für die weitere Bearbeitung exportieren.

Die Berichte beruhen auf den erfassten und geprüften Angaben. Eine amtliche Steuererklärung oder automatische Entscheidung über steuerliche Pflichten ist nicht Bestandteil der Anwendung. Den genauen Umfang beschreibt [ACCOUNTING_SCOPE.md](docs/ACCOUNTING_SCOPE.md).

### Zahlungsentwürfe vorbereiten

Offene Rechnungsbeträge können für Zahlungsentwürfe und SEPA-XML-Exporte verwendet werden. Vorbereitung, Prüfung und Freigabe sind getrennte Schritte.

**Eine echte Bankzahlung wird im aktuellen Community-Kandidaten nicht ausgelöst.** Der vorhandene Übermittlungsablauf arbeitet mit einer lokalen Simulation. Lesender Bankdatenabruf und Zahlungsübermittlung sind unterschiedliche Funktionen.

### Daten und Bearbeitung nachvollziehbar halten

- Lokale Benutzerkonten und Rollen für Eigentümer, Buchhaltung, Zahlungsfreigabe und lesenden Zugriff.
- Nachvollziehbare Änderungen mit Bearbeiter, vorherigem Zustand und Prüfung auf veraltete Bearbeitungsstände.
- Verifizierte Sicherungen einschließlich der Originalbelege sowie eine gestufte, ausdrücklich bestätigte Wiederherstellung.
- Ein Prüf- und Übernahmeablauf für unterstützte Altbestände; keine automatische Umstellung einer bestehenden V2-Installation.
- Getrennte Behandlung von Finanzdaten, Benutzeridentität, Zugangsdaten und Browsersitzungen.

Mehr dazu: [Sicherung und Wiederherstellung](docs/BACKUP_AND_RESTORE.md), [Migrationsrichtlinie](docs/MIGRATION_POLICY.md) und [Schutz finanzieller Daten](docs/FINANCIAL_DATA_SAFETY.md).

## Ein typischer Arbeitsablauf

1. **Konten und Buchungen erfassen:** unterstützte Kontoauszüge prüfen und importieren oder eigene lesende Anbieterzugänge einrichten.
2. **Belege zusammentragen:** vorhandene Dateien hochladen oder Rechnungen über die unterstützten Portalabläufe beschaffen.
3. **Erkennung prüfen:** vorgeschlagene Belegangaben kontrollieren, ergänzen und bestätigen.
4. **Geldflüsse abstimmen:** Vorschläge prüfen, Belege zuordnen und Gebühren, Rückerstattungen oder Umbuchungen auflösen.
5. **Offene Fälle bearbeiten:** fehlende Belege, Restbeträge und widersprüchliche Zuordnungen klären.
6. **Auswerten und sichern:** Berichte für den gewünschten Zeitraum erstellen, Ergebnisse exportieren und eine Sicherung anlegen.

## Demo zum Ausprobieren

Die separate Demo verwendet ausschließlich fiktive Daten. Ein frischer Demobestand enthält 17 Buchungen, 13 Belege, sechs Quellen-/Kontokombinationen und einen lokalen Zahlungsentwurf. Beispiele zeigen unter anderem Gebühren, Rückerstattungen, Fremdwährungen, Teilzahlungen und Anbieter-Auszahlungen.

Zuordnungen und die vorhandenen Prüfoberflächen lassen sich ausprobieren. Weitere Ansichten zeigen die gespeicherten Beispielkonten, Belege, Berichte und Zahlungsentwürfe. Echte Bankaktionen und Anbieterabrufe sind in diesem Modus deaktiviert; er öffnet keinen bestehenden persönlichen Arbeitsbereich.

Mit vorbereiteten Entwicklungsabhängigkeiten, gebautem Frontend und Node 22:

```powershell
npm run demo:windows
```

Das Startprogramm zeigt die lokale Adresse und einen Zugriffscode an. Die Oberfläche startet auf Englisch; Deutsch ist auswählbar. Kurze Erklärtexte und Tooltips sind vorhanden. **Ein geführter Schritt-für-Schritt-Rundgang für Einsteiger ist noch nicht enthalten.** Den genauen Demoumfang beschreibt der [Demo-Vertrag](docs/feature-parity/DEMO_CONTRACT.md).

## Lokal betreiben

Die Anwendung läuft lokal im Browser und bindet standardmäßig nur an die lokale Loopback-Adresse. Finanzdaten liegen in einem eigenen Verzeichnis außerhalb des Programmquellcodes. Anbieterzugriffe erfolgen nur über eingerichtete Verbindungen; lokale Verarbeitung bedeutet nicht, dass externe Anbieter ohne Netzwerk erreichbar wären.

Für das vorbereitete Windows-Entwicklungspaket beschreibt die [Installationsanleitung](docs/INSTALLATION.md) Einrichtung, ersten Eigentümer, Updates und Deinstallation. Dieses Paket enthält die qualifizierte Node-22-Laufzeit, native Module, Offline-OCR-Sprachdaten und das gebaute Frontend.

### Aus dem Quellcode entwickeln

Voraussetzung ist Node.js 22 mit den zum Projekt gehörenden Lockfiles. Root und Frontend haben getrennte Abhängigkeiten.

```powershell
node --version
npm ci --ignore-scripts
npm rebuild better-sqlite3 sharp esbuild
npm ci --ignore-scripts --prefix web
npm run build
powershell -NoProfile -File scripts/Start-Community.ps1 -DataDirectory 'C:\MeineDaten\MatchingToolCommunity'
```

Beim ersten Start zeigt das Startprogramm einen zeitlich begrenzten Einrichtungscode an. Damit wird der erste Eigentümer angelegt; anschließend erfolgt der Zugriff über die normale Anmeldung. Für einen neuen Arbeitsbereich ein eigenständiges Datenverzeichnis verwenden. Zugangsdaten, Einrichtungscodes, Sitzungen und echte Finanzdaten gehören nicht ins Repository oder in Fehlerberichte.

Technische Grundlage: TypeScript, Express, React/Vite und SQLite. Weitere Hinweise stehen unter [Entwicklung](docs/DEVELOPMENT.md), [Konfiguration](docs/CONFIGURATION.md) und [Architektur](docs/ARCHITECTURE.md).

## Projektstand und Prüfungen

Matching Tool Community ist ein privat qualifizierter **Entwicklungskandidat**. Eine Git-Sicherung oder erfolgreiche lokale Tests bedeuten keine pauschale Produktiv-, Anbieter- oder Veröffentlichungsfreigabe. Live-Anbieterzugänge, unabhängige Windows-Abnahme und öffentliche Weitergabe haben eigene Prüfgrenzen.

Für die Entwicklung stehen unter anderem diese Prüfungen zur Verfügung:

```powershell
npm run typecheck
npm test
npm run privacy:check
npm run audit:production
```

Automatisierte fachliche Tests verwenden synthetische Daten. Technische Abnahmen und ihre Grenzen sind in der [Testdokumentation](docs/TESTING.md), der [Funktionsübersicht](docs/feature-parity/02_FEATURE_MATRIX.md) und dem [Release-Prozess](docs/RELEASE_PROCESS.md) beschrieben. Beiträge richten sich nach [CONTRIBUTING.md](CONTRIBUTING.md); Sicherheitsinformationen stehen in [SECURITY.md](SECURITY.md).

## Lizenz und Drittanbieter

Die MIT-Lizenz im Repository ist ein vorläufiger Lizenzvorschlag für den eigenen Originalcode. Sie hebt die Rechte und Bedingungen verwendeter Fremdkomponenten nicht auf und erteilt keine pauschale Freigabe zur öffentlichen Weitergabe.

Maßgeblich sind [LICENSE](LICENSE), [NOTICE](NOTICE), die [Lizenzentscheidung](docs/LICENSE_DECISION.md) und die [Drittanbieter- und Paketdokumentation](docs/compliance/README.md). Hinweise zur Quellenbereitstellung und Paketierung stehen im [Native-/WASM-Quellenplan](docs/compliance/NATIVE_SOURCE_PLAN.md) und im [Paketierungsvertrag](docs/compliance/PACKAGING.md).
