import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Table, Pagination, Badge, colors, formatDateTime, usePageSize } from '../components/shared';

export function AuditTrail() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const { pageSize } = usePageSize();

  const load = () => api.getAudit({ page: String(page), limit: String(pageSize) }).then(setData);
  useEffect(() => { load(); }, [page, pageSize]);

  if (!data) return <p>Loading...</p>;

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
      <h1 style={{ fontSize: 22, marginBottom: 16 }}>Audit Trail</h1>
      <p style={{ fontSize: 13, color: '#666', marginBottom: 16 }}>{data.total} events</p>

      <Card>
        <Table
          headers={['Time', 'Action', 'Entity', 'Entity ID', 'Actor']}
          rows={data.items.map((e: any) => [
            formatDateTime(e.timestamp),
            <Badge text={e.action} color={actionColor[e.action] ?? colors.gray} />,
            e.entity_type,
            <code style={{ fontSize: 11 }}>{e.entity_id?.slice(0, 30)}</code>,
            e.actor_type,
          ])}
        />
        <Pagination page={data.page} pages={data.pages} onPage={setPage} />
      </Card>
    </div>
  );
}
