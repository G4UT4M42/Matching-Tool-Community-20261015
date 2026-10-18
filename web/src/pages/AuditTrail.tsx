import { useLegacyText } from '../i18n/legacy';
import { legacyAccountingEnglish, accountingEnumText } from '../i18n/legacy-accounting';
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Table, Pagination, Badge, colors, formatDateTime, usePageSize } from '../components/shared';

export function AuditTrail() {
  const text = useLegacyText(legacyAccountingEnglish);
  const locale = text('de-DE');
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const { pageSize } = usePageSize();

  const load = () => api.getAudit({ page: String(page), limit: String(pageSize) }).then(setData);
  useEffect(() => { load(); }, [page, pageSize]);

  if (!data) return <p>{text("Laden...")}</p>;

  const actionColor: Record<string, string> = {
    RUN_STARTED: colors.blue,
    RUN_FINISHED: colors.green,
    MATCH_CREATED_MANUAL: colors.green,
    MATCH_DELETED: colors.red,
    EXCLUSION_CREATED: colors.orange,
    EXCLUSION_DELETED: colors.orange,
  };

  return (
    <div>
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>{text("Audit-Verlauf")}</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>{data.total} {text("Ereignisse")}</p>

      <Card>
        <Table
          headers={[text("Zeit"), text("Aktion"), text("Entität"), text("Entitäts-ID"), text("Akteur")]}
          rows={data.items.map((e: any) => [
            formatDateTime(e.timestamp),
            <Badge text={accountingEnumText(text, e.action)} color={actionColor[e.action] ?? colors.gray} />,
            accountingEnumText(text, e.entity_type),
            <code style={{ fontSize: 11 }}>{e.entity_id?.slice(0, 30)}</code>,
            accountingEnumText(text, e.actor_type),
          ])}
        />
        <Pagination page={data.page} pages={data.pages} onPage={setPage} />
      </Card>
    </div>
  );
}
