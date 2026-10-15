export const integrationMessages = {
  en: {
    title: 'Integrations', provider: 'Provider', environment: 'Environment', sandbox: 'Sandbox', test: 'Test', live: 'Live',
    paypal: 'PayPal', stripe: 'Stripe', clientId: 'App client ID', clientSecret: 'App client secret', apiKey: 'Restricted read-only API key',
    configure: 'Save configuration', reconnect: 'Reconnect', testConnection: 'Test connection', synchronize: 'Synchronize', disconnect: 'Disconnect',
    configured: 'Configured (credentials hidden)', unconfigured: 'Not configured', lastSuccess: 'Last successful sync', lastError: 'Last error',
    never: 'Never', success: 'Operation completed', error: 'The integration request failed. Check configuration and permissions.',
    busy: 'Working…', consent: 'Only read-only provider access is used. Financial records are committed through the local accounting coordinator.',
  },
  de: {
    title: 'Integrationen', provider: 'Anbieter', environment: 'Umgebung', sandbox: 'Sandbox', test: 'Test', live: 'Live',
    paypal: 'PayPal', stripe: 'Stripe', clientId: 'App-Client-ID', clientSecret: 'App-Client-Secret', apiKey: 'Eingeschränkter API-Schlüssel mit Lesezugriff',
    configure: 'Konfiguration speichern', reconnect: 'Erneut verbinden', testConnection: 'Verbindung testen', synchronize: 'Synchronisieren', disconnect: 'Trennen',
    configured: 'Konfiguriert (Zugangsdaten verborgen)', unconfigured: 'Nicht konfiguriert', lastSuccess: 'Letzte erfolgreiche Synchronisierung', lastError: 'Letzter Fehler',
    never: 'Nie', success: 'Vorgang abgeschlossen', error: 'Die Integrationsanfrage ist fehlgeschlagen. Konfiguration und Berechtigungen prüfen.',
    busy: 'Wird ausgeführt…', consent: 'Es wird nur lesender Anbieterzugriff verwendet. Finanzdaten werden über die lokale Buchhaltungskoordination gespeichert.',
  },
} as const;
