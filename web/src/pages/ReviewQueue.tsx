import { useLegacyText } from '../i18n/legacy';
import { legacyAccountingEnglish } from '../i18n/legacy-accounting';
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Table, Pagination, Amount, SourceBadge, formatDate, usePageSize, useWorkingYear } from '../components/shared';

export function ReviewQueue() {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const { pageSize } = usePageSize();
  const { workingYear, quarter } = useWorkingYear();

  const load = () => api.getReviewQueue({ page: String(page), limit: String(pageSize), year: String(workingYear), ...(quarter ? { quarter: String(quarter) } : {}) }).then(setData);
  useEffect(() => { load(); }, [page, pageSize, workingYear, quarter]);

  if (!data) return <p>{text("Laden...")}</p>;

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>{text("Prüfliste")}</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>
        {data.total} {text("nicht zugeordnete, nicht ausgeschlossene Transaktionen zur Prüfung (nach Betrag sortiert).")}
      </p>

      <Card>
        <Table
          headers={[text("Datum"), text("Quelle"), text("Beschreibung"), text("Gegenpartei"), text("Betrag")]}
          rows={data.items.map((t: any) => [
            formatDate(t.posting_at),
            <SourceBadge source={t.source_system} />,
            t.description_raw?.slice(0, 80),
            t.counterparty_name ?? '-',
            <Amount value={t.amount} currency={t.currency_code} />,
          ])}
        />
        <Pagination page={data.page} pages={data.pages} onPage={setPage} />
      </Card>
    </div>
  );
}
