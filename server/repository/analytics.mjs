/** Center statistics for a period. Mixed into DetailFlowRepository (server/repository.mjs). */
export const analyticsMethods = {
  getAnalyticsOverview(tenantId, from, to) {
    const bookingRows = this.db.prepare(`SELECT status, COUNT(*) count
      FROM bookings
      WHERE tenant_id = ? AND substr(start_at, 1, 10) BETWEEN ? AND ?
      GROUP BY status`).all(tenantId, from, to);
    const bookingCounts = Object.fromEntries(bookingRows.map((row) => [row.status, Number(row.count)]));

    const orderRows = this.db.prepare(`SELECT status, COUNT(*) count
      FROM orders
      WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ?
      GROUP BY status ORDER BY status`).all(tenantId, from, to);
    const orderStatuses = orderRows.map((row) => ({ status: row.status, count: Number(row.count) }));
    const ordersTotal = orderStatuses.reduce((sum, item) => sum + item.count, 0);
    const statusCount = (status) => orderStatuses.find((item) => item.status === status)?.count ?? 0;

    const approvedEstimates = this.db.prepare(`SELECT
        COALESCE(SUM(e.total_amount_minor), 0) amount,
        COUNT(e.id) count
      FROM orders o
      JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      JOIN estimate_versions e ON e.id = w.current_estimate_version_id AND e.tenant_id = o.tenant_id
      WHERE o.tenant_id = ? AND date(o.created_at) BETWEEN ? AND ?
        AND EXISTS (
          SELECT 1 FROM estimate_approvals a
          WHERE a.order_id = o.id AND a.tenant_id = o.tenant_id
            AND a.estimate_version_id = e.id AND a.decision = 'APPROVED'
        )`).get(tenantId, from, to);

    const operationRows = this.db.prepare(`SELECT op.status, COUNT(*) count
      FROM order_work_operations op
      JOIN orders o ON o.id = op.order_id AND o.tenant_id = op.tenant_id
      WHERE op.tenant_id = ? AND date(o.created_at) BETWEEN ? AND ?
      GROUP BY op.status`).all(tenantId, from, to);
    const operationCounts = Object.fromEntries(operationRows.map((row) => [row.status, Number(row.count)]));
    const operationsTotal = operationRows.reduce((sum, row) => sum + Number(row.count), 0);
    const operationsDone = operationCounts.DONE ?? 0;

    const dailyBookings = this.db.prepare(`SELECT substr(start_at, 1, 10) date, COUNT(*) count
      FROM bookings WHERE tenant_id = ? AND substr(start_at, 1, 10) BETWEEN ? AND ?
      GROUP BY substr(start_at, 1, 10)`).all(tenantId, from, to);
    const dailyOrders = this.db.prepare(`SELECT date(created_at) date,
        COUNT(*) count, SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) closed
      FROM orders WHERE tenant_id = ? AND date(created_at) BETWEEN ? AND ?
      GROUP BY date(created_at)`).all(tenantId, from, to);
    const bookingDays = new Map(dailyBookings.map((row) => [row.date, Number(row.count)]));
    const orderDays = new Map(dailyOrders.map((row) => [row.date, {
      orders: Number(row.count), closed: Number(row.closed)
    }]));
    const daily = [];
    for (let cursor = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); cursor <= end; cursor += 86_400_000) {
      const date = new Date(cursor).toISOString().slice(0, 10);
      daily.push({
        date,
        bookings: bookingDays.get(date) ?? 0,
        orders: orderDays.get(date)?.orders ?? 0,
        closed: orderDays.get(date)?.closed ?? 0
      });
    }

    const approvedAmount = Number(approvedEstimates.amount);
    const approvedCount = Number(approvedEstimates.count);
    return {
      period: { from, to },
      bookings: {
        total: bookingRows.reduce((sum, row) => sum + Number(row.count), 0),
        confirmed: bookingCounts.CONFIRMED ?? 0,
        cancelled: bookingCounts.CANCELLED ?? 0
      },
      orders: {
        total: ordersTotal,
        active: ordersTotal - statusCount('READY') - statusCount('CLOSED'),
        ready: statusCount('READY'),
        closed: statusCount('CLOSED'),
        approvedEstimateAmountMinor: approvedAmount,
        averageApprovedEstimateAmountMinor: approvedCount ? Math.round(approvedAmount / approvedCount) : 0
      },
      operations: {
        total: operationsTotal,
        done: operationsDone,
        blocked: operationCounts.BLOCKED ?? 0,
        completionPercent: operationsTotal ? Math.round(operationsDone / operationsTotal * 100) : 0
      },
      orderStatuses,
      daily
    };
  }
};
