export const persistenceText = {
  en: {
    title: 'Data management', current: 'Current data', backups: 'Backups', create: 'Create backup', download: 'Download',
    restore: 'Restore a backup', choose: 'Choose a backup ZIP', stage: 'Stage and verify', confirm: 'Activate verified backup',
    warning: 'Activation replaces the current accounting dataset. A previous copy remains available for recovery.',
    count: 'Transactions', documents: 'Documents', matches: 'Matches', total: 'Signed totals (minor units)',
    staged: 'Backup verified. Review the financial summary before activation.', error: 'Operation failed',
    legacy: 'Legacy migration', source: 'Legacy source', inspect: 'Inspect and dry run', migrate: 'Stage migration',
    noSources: 'No offline legacy source was selected by the local server.',
  },
  de: {
    title: 'Datenverwaltung', current: 'Aktuelle Daten', backups: 'Sicherungen', create: 'Sicherung erstellen', download: 'Herunterladen',
    restore: 'Sicherung wiederherstellen', choose: 'Sicherungs-ZIP auswählen', stage: 'Bereitstellen und prüfen', confirm: 'Geprüfte Sicherung aktivieren',
    warning: 'Die Aktivierung ersetzt den aktuellen Buchungsbestand. Die vorherige Kopie bleibt für die Wiederherstellung erhalten.',
    count: 'Buchungen', documents: 'Belege', matches: 'Zuordnungen', total: 'Salden je Währung (kleinste Einheit)',
    staged: 'Sicherung geprüft. Prüfen Sie die Finanzübersicht vor der Aktivierung.', error: 'Vorgang fehlgeschlagen',
    legacy: 'Altdaten übernehmen', source: 'Altdatenquelle', inspect: 'Prüfen und simulieren', migrate: 'Migration bereitstellen',
    noSources: 'Der lokale Server hat keine Offline-Altdatenquelle ausgewählt.',
  },
} as const;
