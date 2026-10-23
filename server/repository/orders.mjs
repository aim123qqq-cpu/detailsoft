import { BODY_TYPES } from '../../src/shared/carLayouts.ts';
import { randomUUID, buildDocumentContent, clientId, apiTimestamp } from './shared.mjs';

/** Work orders: intake, estimate, approval, work, handover and acts. Mixed into DetailFlowRepository (server/repository.mjs). */
export const ordersMethods = {
  createOrderFromBooking(tenantId, input) {
    const bookingId = typeof input.bookingId === 'string' ? input.bookingId : '';
    if (!bookingId) return { kind: 'invalid' };
    const existing = this.db.prepare(`SELECT order_id FROM order_workflows
      WHERE tenant_id = ? AND booking_id = ?`).get(tenantId, bookingId);
    if (existing) {
      // Another phone started this intake first: its order stands, the offline one is refused.
      if (input.id !== undefined && input.id !== existing.order_id) {
        return { kind: 'conflict', code: 'order_exists_for_booking', message: 'По этой записи приёмку уже начали на другом устройстве' };
      }
      return { kind: 'replayed', order: this.getOrder(tenantId, existing.order_id) };
    }
    const booking = this.db.prepare(`SELECT id, customer_id, vehicle_id, status
      FROM bookings WHERE id = ? AND tenant_id = ?`).get(bookingId, tenantId);
    if (!booking || booking.status !== 'CONFIRMED') return { kind: 'not_found', resource: 'booking' };

    // An intake started offline names the order on the phone, so its later changes can refer to it.
    const requestedId = clientId(input.id, 'order');
    if (requestedId === null) return { kind: 'invalid' };
    if (requestedId && this.db.prepare('SELECT 1 FROM orders WHERE id = ?').get(requestedId)) {
      return { kind: 'conflict', code: 'order_exists', message: 'Заказ с таким номером уже есть' };
    }
    const orderId = requestedId ?? `order_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO orders (id, tenant_id, customer_id, vehicle_id, status)
        VALUES (?, ?, ?, ?, 'INTAKE')`).run(orderId, tenantId, booking.customer_id, booking.vehicle_id);
      this.db.prepare(`INSERT INTO order_workflows (order_id, tenant_id, booking_id)
        VALUES (?, ?, ?)`).run(orderId, tenantId, bookingId);
      this.insertOrderAudit(tenantId, orderId, 'ORDER_CREATED', { bookingId });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', order: this.getOrder(tenantId, orderId) };
  },

  saveOrderIntake(tenantId, orderId, input) {
    const order = this.db.prepare(`SELECT o.id, o.status FROM orders o
      JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status === 'APPROVED') {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Согласованный заказ нельзя вернуть к приёмке' };
    }
    const conditionSummary = String(input.conditionSummary ?? '').trim();
    const findings = Array.isArray(input.findings) ? input.findings : null;
    const recommendations = Array.isArray(input.recommendations) ? input.recommendations : null;
    const validFinding = (item) => item && String(item.zone ?? '').trim() &&
      ['LOW', 'MEDIUM', 'HIGH'].includes(item.severity) && String(item.note ?? '').trim();
    const validRecommendation = (item) => item && String(item.title ?? '').trim() &&
      String(item.reason ?? '').trim() && ['OPTIONAL', 'RECOMMENDED', 'URGENT'].includes(item.priority);
    // The body type picks the inspection diagram; findings name its elements.
    const bodyType = input.bodyType === undefined || input.bodyType === null ? null : String(input.bodyType);
    if (conditionSummary.length < 3 || !findings || !recommendations || findings.length > 40 || recommendations.length > 20 ||
      findings.some((item) => !validFinding(item)) || recommendations.some((item) => !validRecommendation(item)) ||
      (bodyType !== null && !BODY_TYPES.some((item) => item.code === bodyType))) {
      return { kind: 'invalid' };
    }

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_intakes (order_id, condition_summary, completed_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(order_id) DO UPDATE SET condition_summary = excluded.condition_summary, completed_at = CURRENT_TIMESTAMP`)
        .run(orderId, conditionSummary);
      this.db.prepare('DELETE FROM inspection_findings WHERE order_id = ?').run(orderId);
      this.db.prepare('DELETE FROM order_recommendations WHERE order_id = ?').run(orderId);
      const insertFinding = this.db.prepare(`INSERT INTO inspection_findings
        (id, order_id, zone, severity, note) VALUES (?, ?, ?, ?, ?)`);
      for (const finding of findings) insertFinding.run(
        `finding_${randomUUID()}`, orderId, String(finding.zone).trim(), finding.severity, String(finding.note).trim()
      );
      const insertRecommendation = this.db.prepare(`INSERT INTO order_recommendations
        (id, order_id, title, reason, priority) VALUES (?, ?, ?, ?, ?)`);
      for (const recommendation of recommendations) insertRecommendation.run(
        `recommendation_${randomUUID()}`, orderId, String(recommendation.title).trim(),
        String(recommendation.reason).trim(), recommendation.priority
      );
      if (bodyType) this.db.prepare(`INSERT INTO order_intake_body_types (order_id, tenant_id, body_type) VALUES (?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET body_type = excluded.body_type`).run(orderId, tenantId, bodyType);
      this.db.prepare(`UPDATE orders SET status = 'ESTIMATE_DRAFT' WHERE id = ? AND tenant_id = ?`)
        .run(orderId, tenantId);
      this.db.prepare('UPDATE order_workflows SET updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run(orderId);
      this.insertOrderAudit(tenantId, orderId, 'INTAKE_COMPLETED', {
        findings: findings.length, recommendations: recommendations.length
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  addOrderPhoto(tenantId, orderId, input) {
    const order = this.db.prepare(`SELECT id, status FROM orders WHERE id = ? AND tenant_id = ?`)
      .get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    const phase = input.phase === 'result' ? 'result' : 'intake';
    const allowedStatus = phase === 'result' ? order.status === 'READY' : ['INTAKE', 'ESTIMATE_DRAFT'].includes(order.status);
    if (!allowedStatus) return { kind: 'conflict', code: 'invalid_order_state', message: phase === 'result'
      ? 'Фото результата можно добавить только перед выдачей'
      : 'В закрытую приёмку нельзя добавлять фото' };
    const kind = String(input.kind ?? 'intake');
    const zone = String(input.zone ?? '').trim();
    const dataUrl = String(input.dataUrl ?? '');
    const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    const bytes = match ? Buffer.from(match[2], 'base64') : null;
    const currentCount = this.db.prepare(`SELECT COUNT(*) AS count FROM order_photos
      WHERE tenant_id = ? AND order_id = ?`).get(tenantId, orderId).count;
    if (!['intake', 'defect'].includes(kind) || (phase === 'result' && kind !== 'intake') || !zone || zone.length > 80 || !bytes ||
      bytes.length < 1 || bytes.length > 700 * 1024 || currentCount >= 20 || (phase === 'intake' && currentCount >= 19)) return { kind: 'invalid' };

    const id = `photo_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_photos
        (id, tenant_id, order_id, kind, zone, mime_type, data_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, tenantId, orderId, kind, zone, match[1], dataUrl);
      if (phase === 'result') this.db.prepare(`INSERT INTO order_result_photos
        (photo_id, tenant_id, order_id) VALUES (?, ?, ?)`).run(id, tenantId, orderId);
      this.insertOrderAudit(tenantId, orderId, phase === 'result' ? 'RESULT_PHOTO_ADDED' : 'INTAKE_PHOTO_ADDED', {
        photoId: id, kind, zone
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    const photo = this.db.prepare(`SELECT id, kind, zone, mime_type, data_url, created_at
      FROM order_photos WHERE id = ? AND tenant_id = ?`).get(id, tenantId);
    return { kind: 'created', photo: {
      id: photo.id,
      phase,
      kind: photo.kind,
      zone: photo.zone,
      mimeType: photo.mime_type,
      dataUrl: photo.data_url,
      createdAt: apiTimestamp(photo.created_at)
    } };
  },

  createEstimateVersion(tenantId, orderId, input) {
    const order = this.db.prepare(`SELECT o.id, o.status FROM orders o
      JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'ESTIMATE_DRAFT') return { kind: 'conflict', code: 'invalid_order_state', message: 'Сначала завершите приёмку' };
    const lines = Array.isArray(input.lines) ? input.lines : null;
    const validLine = (line) => line && ['service', 'package', 'recommendation', 'custom'].includes(line.sourceType) &&
      String(line.name ?? '').trim() && Number.isInteger(line.amountMinor) && line.amountMinor >= 0 &&
      Number.isInteger(line.durationMinutes) && line.durationMinutes >= 0;
    if (!lines || lines.length < 1 || lines.length > 30 || lines.some((line) => !validLine(line))) return { kind: 'invalid' };
    // Offline phones choose the version and line ids: approval and work operations refer to them.
    const requestedId = clientId(input.id, 'estimate');
    const lineIds = lines.map((line) => clientId(line.id, 'estimate_line'));
    if (requestedId === null || lineIds.some((id) => id === null) || new Set(lineIds.filter(Boolean)).size !== lineIds.filter(Boolean).length) return { kind: 'invalid' };
    if ((requestedId && this.db.prepare('SELECT 1 FROM estimate_versions WHERE id = ?').get(requestedId)) ||
      lineIds.some((id) => id && this.db.prepare('SELECT 1 FROM estimate_lines WHERE id = ?').get(id))) {
      return { kind: 'conflict', code: 'estimate_exists', message: 'Смета с таким номером уже есть' };
    }

    const version = this.db.prepare('SELECT COALESCE(MAX(version), 0) + 1 version FROM estimate_versions WHERE order_id = ?')
      .get(orderId).version;
    const estimateVersionId = requestedId ?? `estimate_${randomUUID()}`;
    const totalAmountMinor = lines.reduce((sum, line) => sum + line.amountMinor, 0);
    const totalDurationMinutes = lines.reduce((sum, line) => sum + line.durationMinutes, 0);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO estimate_versions
        (id, tenant_id, order_id, version, total_amount_minor, total_duration_minutes)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
          estimateVersionId, tenantId, orderId, version, totalAmountMinor, totalDurationMinutes
        );
      const insertLine = this.db.prepare(`INSERT INTO estimate_lines
        (id, estimate_version_id, sequence, source_type, source_id, name, amount_minor, duration_minutes, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      lines.forEach((line, index) => insertLine.run(
        lineIds[index] ?? `estimate_line_${randomUUID()}`, estimateVersionId, index + 1, line.sourceType,
        line.sourceId ?? null, String(line.name).trim(), line.amountMinor, line.durationMinutes,
        String(line.reason ?? '').trim() || null
      ));
      this.db.prepare(`UPDATE order_workflows
        SET current_estimate_version_id = ?, updated_at = CURRENT_TIMESTAMP WHERE order_id = ?`)
        .run(estimateVersionId, orderId);
      this.insertOrderAudit(tenantId, orderId, 'ESTIMATE_VERSION_CREATED', { estimateVersionId, version });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', estimate: this.getEstimateVersion(tenantId, estimateVersionId) };
  },

  decideEstimate(tenantId, orderId, input) {
    if (!['APPROVED', 'REJECTED'].includes(input.decision) ||
      !['in_person', 'phone', 'messenger'].includes(input.method) ||
      !String(input.estimateVersionId ?? '').trim() || !String(input.source ?? '').trim() || !String(input.responsible ?? '').trim()) {
      return { kind: 'invalid' };
    }
    const order = this.db.prepare(`SELECT o.status, w.current_estimate_version_id
      FROM orders o JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.current_estimate_version_id !== input.estimateVersionId) {
      return { kind: 'conflict', code: 'stale_estimate', message: 'Можно согласовать только актуальную версию сметы' };
    }
    const existing = this.db.prepare(`SELECT id FROM estimate_approvals
      WHERE order_id = ? AND estimate_version_id = ?`).get(orderId, input.estimateVersionId);
    if (existing) return { kind: 'conflict', code: 'estimate_already_decided', message: 'Решение по этой версии уже сохранено' };

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO estimate_approvals
        (id, tenant_id, order_id, estimate_version_id, decision, method, source, responsible)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          `approval_${randomUUID()}`, tenantId, orderId, input.estimateVersionId, input.decision,
          input.method, String(input.source).trim(), String(input.responsible).trim()
        );
      const nextStatus = input.decision === 'APPROVED' ? 'APPROVED' : 'ESTIMATE_DRAFT';
      this.db.prepare('UPDATE orders SET status = ? WHERE id = ? AND tenant_id = ?').run(nextStatus, orderId, tenantId);
      this.db.prepare('UPDATE order_workflows SET updated_at = CURRENT_TIMESTAMP WHERE order_id = ?').run(orderId);
      this.insertOrderAudit(tenantId, orderId, `ESTIMATE_${input.decision}`, {
        estimateVersionId: input.estimateVersionId, method: input.method, source: input.source, responsible: input.responsible
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  insertOrderAudit(tenantId, orderId, eventType, metadata = {}) {
    this.db.prepare(`INSERT INTO order_audit_events
      (id, tenant_id, order_id, event_type, metadata_json) VALUES (?, ?, ?, ?, ?)`)
      .run(`audit_${randomUUID()}`, tenantId, orderId, eventType, JSON.stringify(metadata));
  },

  getEstimateVersion(tenantId, estimateVersionId) {
    const row = this.db.prepare(`SELECT id, order_id, version, total_amount_minor, total_duration_minutes, created_at
      FROM estimate_versions WHERE id = ? AND tenant_id = ?`).get(estimateVersionId, tenantId);
    if (!row) return null;
    return {
      id: row.id,
      orderId: row.order_id,
      version: row.version,
      totalAmountMinor: row.total_amount_minor,
      totalDurationMinutes: row.total_duration_minutes,
      createdAt: apiTimestamp(row.created_at),
      lines: this.db.prepare(`SELECT id, source_type, source_id, name, amount_minor, duration_minutes, reason
        FROM estimate_lines WHERE estimate_version_id = ? ORDER BY sequence`).all(row.id).map((line) => ({
          id: line.id,
          sourceType: line.source_type,
          sourceId: line.source_id,
          name: line.name,
          amountMinor: line.amount_minor,
          durationMinutes: line.duration_minutes,
          reason: line.reason
        }))
    };
  },

  /** Active team members whose roles grant acceptAssignments, with their workload (approved or in-progress orders). */
  listMasters(tenantId) {
    return this.db.prepare(`SELECT m.id, m.display_name, m.roles_json,
        (SELECT COUNT(*) FROM order_assignment_members a JOIN orders o ON o.id = a.order_id AND o.tenant_id = a.tenant_id
          WHERE a.tenant_id = m.tenant_id AND a.member_id = m.id AND o.status IN ('APPROVED', 'IN_PROGRESS')) active_orders
      FROM tenant_members m WHERE m.tenant_id = ? AND m.status = 'active'
      ORDER BY active_orders, m.display_name`).all(tenantId)
      .filter((row) => this.roles.permissionsFor(tenantId, JSON.parse(row.roles_json)).has('acceptAssignments'))
      .map((row) => ({ id: row.id, displayName: row.display_name, activeOrders: row.active_orders }));
  },

  assignOrderMaster(tenantId, orderId, input) {
    // Preferred: a real team member (memberId). Legacy clients may still send a free-text masterName.
    const memberId = typeof input?.memberId === 'string' && input.memberId ? input.memberId : null;
    let masterName = String(input?.masterName ?? '').trim();
    if (memberId) {
      const member = this.db.prepare(`SELECT display_name, roles_json, status FROM tenant_members
        WHERE id = ? AND tenant_id = ?`).get(memberId, tenantId);
      if (!member || member.status !== 'active' ||
        !this.roles.permissionsFor(tenantId, JSON.parse(member.roles_json)).has('acceptAssignments')) {
        return { kind: 'invalid', code: 'not_a_master' };
      }
      masterName = member.display_name;
    } else if (masterName.length < 2 || masterName.length > 120) return { kind: 'invalid' };
    const order = this.db.prepare(`SELECT id, status FROM orders WHERE id = ? AND tenant_id = ?`)
      .get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'APPROVED') {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Мастера можно назначить после согласования сметы' };
    }
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_assignments (order_id, tenant_id, master_name, assigned_at)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(order_id) DO UPDATE SET master_name = excluded.master_name, assigned_at = CURRENT_TIMESTAMP`)
        .run(orderId, tenantId, masterName);
      this.db.prepare('DELETE FROM order_assignment_members WHERE order_id = ? AND tenant_id = ?').run(orderId, tenantId);
      if (memberId) this.db.prepare(`INSERT INTO order_assignment_members (order_id, tenant_id, member_id)
        VALUES (?, ?, ?)`).run(orderId, tenantId, memberId);
      this.insertOrderAudit(tenantId, orderId, 'MASTER_ASSIGNED', { masterName, memberId });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  startOrderWork(tenantId, orderId) {
    const order = this.db.prepare(`SELECT o.status, w.current_estimate_version_id, a.master_name
      FROM orders o
      JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      LEFT JOIN order_assignments a ON a.order_id = o.id AND a.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'APPROVED' || !order.master_name || !order.current_estimate_version_id) {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Нужны согласованная смета и назначенный мастер' };
    }
    if (this.db.prepare('SELECT order_id FROM order_work_runs WHERE order_id = ?').get(orderId)) {
      return { kind: 'conflict', code: 'work_already_started', message: 'Работы уже начаты' };
    }
    const lines = this.db.prepare(`SELECT id, name, amount_minor FROM estimate_lines
      WHERE estimate_version_id = ? ORDER BY sequence`).all(order.current_estimate_version_id);
    if (!lines.length) return { kind: 'conflict', code: 'estimate_empty', message: 'В согласованной смете нет операций' };

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_work_runs (order_id, tenant_id, status) VALUES (?, ?, 'ACTIVE')`)
        .run(orderId, tenantId);
      const insertOperation = this.db.prepare(`INSERT INTO order_work_operations
        (id, tenant_id, order_id, estimate_line_id, source, sequence, name, amount_minor)
        VALUES (?, ?, ?, ?, 'estimate', ?, ?, ?)`);
      // Derived from the estimate line, so a phone that started work offline knows the ids too.
      lines.forEach((line, index) => insertOperation.run(
        `work_operation_${line.id}`, tenantId, orderId, line.id, index + 1, line.name, line.amount_minor
      ));
      this.db.prepare(`UPDATE orders SET status = 'IN_PROGRESS' WHERE id = ? AND tenant_id = ?`).run(orderId, tenantId);
      this.insertOrderAudit(tenantId, orderId, 'WORK_STARTED', { masterName: order.master_name });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  updateWorkOperation(tenantId, orderId, operationId, input) {
    const status = input?.status;
    const note = String(input?.note ?? '').trim();
    if (!['PENDING', 'DONE', 'BLOCKED'].includes(status) || note.length > 500) return { kind: 'invalid' };
    const order = this.db.prepare(`SELECT o.status, r.status work_status FROM orders o
      JOIN order_work_runs r ON r.order_id = o.id AND r.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'IN_PROGRESS' || order.work_status !== 'ACTIVE') {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Операции доступны только во время работ' };
    }
    const result = this.db.prepare(`UPDATE order_work_operations
      SET status = ?, note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND order_id = ? AND tenant_id = ?`).run(status, note || null, operationId, orderId, tenantId);
    if (!result.changes) return { kind: 'not_found' };
    this.insertOrderAudit(tenantId, orderId, 'WORK_OPERATION_UPDATED', { operationId, status });
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  setWorkPause(tenantId, orderId, paused, input = {}) {
    const note = String(input?.note ?? '').trim();
    if (paused && (note.length < 3 || note.length > 500)) return { kind: 'invalid' };
    const order = this.db.prepare(`SELECT o.status, r.status work_status FROM orders o
      JOIN order_work_runs r ON r.order_id = o.id AND r.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    const expected = paused ? 'ACTIVE' : 'PAUSED';
    if (order.status !== 'IN_PROGRESS' || order.work_status !== expected) {
      return { kind: 'conflict', code: 'invalid_order_state', message: paused ? 'Работы нельзя поставить на паузу' : 'Работы не находятся на паузе' };
    }
    this.db.prepare(`UPDATE order_work_runs SET status = ?, pause_note = ?, updated_at = CURRENT_TIMESTAMP
      WHERE order_id = ? AND tenant_id = ?`).run(paused ? 'PAUSED' : 'ACTIVE', paused ? note : null, orderId, tenantId);
    this.insertOrderAudit(tenantId, orderId, paused ? 'WORK_PAUSED' : 'WORK_RESUMED', paused ? { note } : {});
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  completeOrderWork(tenantId, orderId, { qualityControlEnabled = false } = {}) {
    const order = this.db.prepare(`SELECT o.status, r.status work_status FROM orders o
      JOIN order_work_runs r ON r.order_id = o.id AND r.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'IN_PROGRESS' || order.work_status !== 'ACTIVE') {
      return { kind: 'conflict', code: 'invalid_order_state', message: 'Активные работы не найдены' };
    }
    const incomplete = this.db.prepare(`SELECT COUNT(*) count FROM order_work_operations
      WHERE order_id = ? AND tenant_id = ? AND status != 'DONE'`).get(orderId, tenantId).count;
    if (incomplete) return { kind: 'conflict', code: 'operations_incomplete', message: 'Завершите все согласованные операции' };
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE order_work_runs SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND tenant_id = ?`).run(orderId, tenantId);
      const nextStatus = qualityControlEnabled ? 'QC' : 'READY';
      this.db.prepare(`UPDATE orders SET status = ? WHERE id = ? AND tenant_id = ?`).run(nextStatus, orderId, tenantId);
      this.insertOrderAudit(tenantId, orderId, 'WORK_COMPLETED', { nextStatus });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  releaseDeprecatedQualityControlOrders() {
    const orders = this.db.prepare(`SELECT id, tenant_id FROM orders WHERE status = 'QC'`).all();
    if (!orders.length) return 0;
    this.db.exec('BEGIN');
    try {
      for (const order of orders) {
        this.db.prepare(`UPDATE orders SET status = 'READY' WHERE id = ? AND tenant_id = ?`).run(order.id, order.tenant_id);
        this.insertOrderAudit(order.tenant_id, order.id, 'QC_DEPRECATED_BYPASS', { nextStatus: 'READY' });
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return orders.length;
  },

  submitQualityControl(tenantId, orderId, input) {
    const decision = input?.decision;
    const responsible = String(input?.responsible ?? '').trim();
    const note = String(input?.note ?? '').trim();
    const checks = Array.isArray(input?.checks) ? input.checks : null;
    const validCheck = (check) => check && typeof check.code === 'string' && check.code.trim() &&
      typeof check.label === 'string' && check.label.trim() && typeof check.passed === 'boolean';
    if (!['PASSED', 'REWORK'].includes(decision) || responsible.length < 2 || note.length < 2 ||
      !checks || checks.length < 1 || checks.length > 20 || checks.some((check) => !validCheck(check))) return { kind: 'invalid' };
    if (decision === 'PASSED' && checks.some((check) => !check.passed)) {
      return { kind: 'conflict', code: 'qc_checks_failed', message: 'Нельзя допустить к выдаче с непройденными проверками' };
    }
    if (decision === 'REWORK' && checks.every((check) => check.passed)) {
      return { kind: 'conflict', code: 'qc_rework_without_failure', message: 'Укажите замечание для доработки' };
    }
    const order = this.db.prepare(`SELECT status FROM orders WHERE id = ? AND tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'QC') return { kind: 'conflict', code: 'invalid_order_state', message: 'Заказ не находится на контроле качества' };

    const inspectionId = `qc_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO qc_inspections
        (id, tenant_id, order_id, decision, responsible, note) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(inspectionId, tenantId, orderId, decision, responsible, note);
      const insertCheck = this.db.prepare(`INSERT INTO qc_check_items
        (id, inspection_id, code, label, passed) VALUES (?, ?, ?, ?, ?)`);
      for (const check of checks) insertCheck.run(
        `qc_check_${randomUUID()}`, inspectionId, check.code.trim(), check.label.trim(), check.passed ? 1 : 0
      );
      if (decision === 'PASSED') {
        this.db.prepare(`UPDATE orders SET status = 'READY' WHERE id = ? AND tenant_id = ?`).run(orderId, tenantId);
      } else {
        let sequence = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) max_sequence
          FROM order_work_operations WHERE order_id = ? AND tenant_id = ?`).get(orderId, tenantId).max_sequence;
        const insertRework = this.db.prepare(`INSERT INTO order_work_operations
          (id, tenant_id, order_id, source, sequence, name, amount_minor, status, note)
          VALUES (?, ?, ?, 'qc_rework', ?, ?, 0, 'PENDING', ?)`);
        for (const check of checks.filter((item) => !item.passed)) {
          sequence += 1;
          insertRework.run(`work_operation_${randomUUID()}`, tenantId, orderId, sequence, `Доработка: ${check.label.trim()}`, note);
        }
        this.db.prepare(`UPDATE order_work_runs SET status = 'ACTIVE', completed_at = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE order_id = ? AND tenant_id = ?`).run(orderId, tenantId);
        this.db.prepare(`UPDATE orders SET status = 'IN_PROGRESS' WHERE id = ? AND tenant_id = ?`).run(orderId, tenantId);
      }
      this.insertOrderAudit(tenantId, orderId, decision === 'PASSED' ? 'QC_PASSED' : 'QC_REWORK', {
        inspectionId, responsible, failedChecks: checks.filter((check) => !check.passed).map((check) => check.code)
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  closeOrderHandover(tenantId, orderId, input) {
    const responsible = String(input?.responsible ?? '').trim();
    const note = String(input?.note ?? '').trim();
    if (responsible.length < 2 || note.length < 2) return { kind: 'invalid' };
    const order = this.db.prepare(`SELECT status FROM orders WHERE id = ? AND tenant_id = ?`).get(orderId, tenantId);
    if (!order) return { kind: 'not_found' };
    if (order.status !== 'READY') return { kind: 'conflict', code: 'invalid_order_state', message: 'Заказ не готов к выдаче' };
    const photos = this.db.prepare(`SELECT
        SUM(CASE WHEN result.photo_id IS NULL THEN 1 ELSE 0 END) AS intake_count,
        SUM(CASE WHEN result.photo_id IS NOT NULL THEN 1 ELSE 0 END) AS result_count
      FROM order_photos photo
      LEFT JOIN order_result_photos result ON result.photo_id = photo.id AND result.tenant_id = photo.tenant_id
      WHERE photo.order_id = ? AND photo.tenant_id = ?`).get(orderId, tenantId);
    if (!photos.intake_count || !photos.result_count) return {
      kind: 'conflict', code: 'handover_photos_required', message: 'Добавьте фото автомобиля до и после работ'
    };
    const customerAccepted = input?.customerAccepted === true;
    const completenessChecked = input?.completenessChecked === true;
    if (!customerAccepted || !completenessChecked) return { kind: 'invalid' };

    this.db.exec('BEGIN');
    try {
      this.db.prepare(`INSERT INTO order_handovers (order_id, tenant_id, responsible, note)
        VALUES (?, ?, ?, ?)`).run(orderId, tenantId, responsible, note);
      this.db.prepare(`UPDATE orders SET status = 'CLOSED' WHERE id = ? AND tenant_id = ?`).run(orderId, tenantId);
      this.insertOrderAudit(tenantId, orderId, 'ORDER_CLOSED', {
        responsible, note, customerAccepted, completenessChecked
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', order: this.getOrder(tenantId, orderId) };
  },

  // Builds the frozen content of an order document from the current order state.
  // It is stored verbatim at issue time, so later edits never change an issued act.
  buildOrderDocumentContent(tenantId, orderId, type) {
    const order = this.getOrder(tenantId, orderId);
    if (!order) return { kind: 'not_found' };
    const parties = this.db.prepare(`SELECT t.name tenant_name, c.name customer_name, c.phone_display,
        v.make, v.model, v.generation, v.plate_display, v.color
      FROM orders o
      JOIN tenants t ON t.id = o.tenant_id
      JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      JOIN vehicles v ON v.id = o.vehicle_id AND v.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`).get(orderId, tenantId);
    // The same builder runs on a phone that prepares and signs the act offline.
    return buildDocumentContent(order, {
      centerName: parties.tenant_name,
      requisites: this.getTenantRequisites(tenantId),
      customer: { name: parties.customer_name, phoneDisplay: parties.phone_display },
      vehicle: { make: parties.make, model: parties.model, generation: parties.generation, plate: parties.plate_display, color: parties.color }
    }, type);
  },

  listOrderDocuments(tenantId, orderId) {
    if (!this.db.prepare('SELECT 1 FROM orders WHERE id = ? AND tenant_id = ?').get(orderId, tenantId)) return null;
    const intakeCompletedAt = this.db.prepare('SELECT completed_at FROM order_intakes WHERE order_id = ?').get(orderId)?.completed_at ?? null;
    const seenTypes = new Set();
    return this.db.prepare(`SELECT id, document_type, number, signer_name, signature_data_url IS NOT NULL signed, actor_name, created_at
      FROM order_documents WHERE tenant_id = ? AND order_id = ?
      ORDER BY created_at DESC, rowid DESC`).all(tenantId, orderId).map((row) => {
        const current = !seenTypes.has(row.document_type);
        seenTypes.add(row.document_type);
        return {
          id: row.id,
          type: row.document_type,
          number: row.number,
          signed: row.signed === 1,
          signerName: row.signer_name,
          signedAt: row.signed === 1 ? apiTimestamp(row.created_at) : null,
          actorName: row.actor_name,
          createdAt: apiTimestamp(row.created_at),
          current,
          // A re-saved intake after the act was issued makes the act describe an older inspection.
          outdated: row.document_type === 'intake_act' && intakeCompletedAt !== null && intakeCompletedAt > row.created_at
        };
      });
  },

  getOrderDocument(tenantId, orderId, documentId) {
    const summary = this.listOrderDocuments(tenantId, orderId)?.find((item) => item.id === documentId);
    if (!summary) return null;
    const row = this.db.prepare(`SELECT content_json, signature_data_url FROM order_documents
      WHERE id = ? AND tenant_id = ? AND order_id = ?`).get(documentId, tenantId, orderId);
    return { ...summary, content: JSON.parse(row.content_json), signatureDataUrl: row.signature_data_url };
  },

  issueOrderDocument(tenantId, orderId, input, actorName = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'invalid' };
    if (Object.keys(input).some((key) => !['type', 'signerName', 'signatureDataUrl'].includes(key))) return { kind: 'invalid' };
    if (!['intake_act', 'handover_act'].includes(input.type)) return { kind: 'invalid' };
    const hasSignature = input.signatureDataUrl !== undefined && input.signatureDataUrl !== null;
    const hasSigner = input.signerName !== undefined && input.signerName !== null;
    if (hasSignature !== hasSigner) return { kind: 'invalid' };
    let signerName = null;
    let signatureDataUrl = null;
    if (hasSignature) {
      if (typeof input.signatureDataUrl !== 'string' || typeof input.signerName !== 'string') return { kind: 'invalid' };
      signerName = input.signerName.trim();
      const match = input.signatureDataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
      const bytes = match ? Buffer.from(match[1], 'base64') : null;
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      if (signerName.length < 2 || signerName.length > 120 || !bytes || bytes.length < 8 || bytes.length > 200 * 1024 ||
        pngSignature.some((byte, index) => bytes[index] !== byte)) return { kind: 'invalid' };
      signatureDataUrl = input.signatureDataUrl;
    }

    const built = this.buildOrderDocumentContent(tenantId, orderId, input.type);
    if (built.kind !== 'built') return built;
    const id = `doc_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      const sequence = this.db.prepare(`SELECT COALESCE(MAX(sequence), 0) + 1 next FROM order_documents
        WHERE tenant_id = ? AND document_type = ?`).get(tenantId, input.type).next;
      const number = `${input.type === 'intake_act' ? 'АП' : 'АВ'}-${String(sequence).padStart(6, '0')}`;
      this.db.prepare(`INSERT INTO order_documents
        (id, tenant_id, order_id, document_type, sequence, number, content_json, signer_name, signature_data_url, actor_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          id, tenantId, orderId, input.type, sequence, number, JSON.stringify(built.content), signerName, signatureDataUrl, actorName
        );
      this.insertOrderAudit(tenantId, orderId, 'DOCUMENT_ISSUED', { documentId: id, type: input.type, number, signed: hasSignature });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', document: this.getOrderDocument(tenantId, orderId, id) };
  },

  listOrders(tenantId, limit = 20) {
    const requestedLimit = Number(limit);
    const boundedLimit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 20;
    return this.db.prepare(`SELECT o.id, o.status, o.created_at,
        c.id customer_id, c.name customer_name, c.phone_display customer_phone,
        v.id vehicle_id, v.make, v.model, v.generation, v.plate_display, v.color, v.body_type,
        e.total_amount_minor, a.master_name, am.member_id master_member_id
      FROM orders o
      JOIN customers c ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
      JOIN vehicles v ON v.id = o.vehicle_id AND v.tenant_id = o.tenant_id
      LEFT JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      LEFT JOIN estimate_versions e ON e.id = w.current_estimate_version_id AND e.tenant_id = o.tenant_id
      LEFT JOIN order_assignments a ON a.order_id = o.id AND a.tenant_id = o.tenant_id
      LEFT JOIN order_assignment_members am ON am.order_id = o.id AND am.tenant_id = o.tenant_id
      WHERE o.tenant_id = ?
      ORDER BY o.created_at DESC, o.rowid DESC
      LIMIT ?`).all(tenantId, boundedLimit).map((row) => ({
        id: row.id,
        status: row.status,
        createdAt: apiTimestamp(row.created_at),
        totalAmountMinor: row.total_amount_minor ?? null,
        masterName: row.master_name ?? null,
        masterMemberId: row.master_member_id ?? null,
        customer: {
          id: row.customer_id,
          name: row.customer_name,
          phoneDisplay: row.customer_phone
        },
        vehicle: {
          id: row.vehicle_id,
          make: row.make,
          model: row.model,
          generation: row.generation,
          plate: row.plate_display,
          color: row.color,
          bodyType: row.body_type
        }
      }));
  },

  getOrder(tenantId, orderId) {
    const row = this.db.prepare(`SELECT o.id, o.customer_id, o.vehicle_id, o.status, o.created_at,
        w.booking_id, w.current_estimate_version_id
      FROM orders o LEFT JOIN order_workflows w ON w.order_id = o.id AND w.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`)
      .get(orderId, tenantId);
    if (!row) return null;
    const intake = this.db.prepare(`SELECT condition_summary, completed_at FROM order_intakes WHERE order_id = ?`).get(orderId);
    const approval = this.db.prepare(`SELECT estimate_version_id, decision, method, source, responsible, decided_at
      FROM estimate_approvals WHERE order_id = ? ORDER BY decided_at DESC, rowid DESC LIMIT 1`).get(orderId);
    const assignment = this.db.prepare(`SELECT a.master_name, a.assigned_at, am.member_id FROM order_assignments a
      LEFT JOIN order_assignment_members am ON am.order_id = a.order_id AND am.tenant_id = a.tenant_id
      WHERE a.order_id = ? AND a.tenant_id = ?`).get(orderId, tenantId);
    const workRun = this.db.prepare(`SELECT status, pause_note, started_at, updated_at, completed_at
      FROM order_work_runs WHERE order_id = ? AND tenant_id = ?`).get(orderId, tenantId);
    const handover = this.db.prepare(`SELECT responsible, note, handed_over_at FROM order_handovers
      WHERE order_id = ? AND tenant_id = ?`).get(orderId, tenantId);
    return {
      id: row.id,
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      status: row.status,
      createdAt: apiTimestamp(row.created_at),
      bookingId: row.booking_id ?? null,
      currentEstimateVersionId: row.current_estimate_version_id ?? null,
      photos: this.db.prepare(`SELECT photo.id, photo.kind, photo.zone, photo.mime_type, photo.data_url, photo.created_at,
          CASE WHEN result.photo_id IS NULL THEN 'intake' ELSE 'result' END AS phase
        FROM order_photos photo
        LEFT JOIN order_result_photos result ON result.photo_id = photo.id AND result.tenant_id = photo.tenant_id
        WHERE photo.order_id = ? AND photo.tenant_id = ? ORDER BY photo.created_at, photo.rowid`).all(orderId, tenantId)
        .map((photo) => ({
          id: photo.id,
          phase: photo.phase,
          kind: photo.kind,
          zone: photo.zone,
          mimeType: photo.mime_type,
          dataUrl: photo.data_url,
          createdAt: apiTimestamp(photo.created_at)
        })),
      intake: intake ? {
        bodyType: this.db.prepare('SELECT body_type FROM order_intake_body_types WHERE order_id = ? AND tenant_id = ?').get(orderId, tenantId)?.body_type ?? null,
        conditionSummary: intake.condition_summary,
        completedAt: apiTimestamp(intake.completed_at),
        findings: this.db.prepare(`SELECT id, zone, severity, note FROM inspection_findings
          WHERE order_id = ? ORDER BY created_at, rowid`).all(orderId),
        recommendations: this.db.prepare(`SELECT id, title, reason, priority FROM order_recommendations
          WHERE order_id = ? ORDER BY created_at, rowid`).all(orderId)
      } : null,
      estimateVersions: this.db.prepare(`SELECT id FROM estimate_versions
        WHERE order_id = ? AND tenant_id = ? ORDER BY version`).all(orderId, tenantId)
        .map((estimate) => this.getEstimateVersion(tenantId, estimate.id)),
      approval: approval ? {
        estimateVersionId: approval.estimate_version_id,
        decision: approval.decision,
        method: approval.method,
        source: approval.source,
        responsible: approval.responsible,
        decidedAt: apiTimestamp(approval.decided_at)
      } : null,
      assignment: assignment ? {
        masterName: assignment.master_name,
        memberId: assignment.member_id ?? null,
        assignedAt: apiTimestamp(assignment.assigned_at)
      } : null,
      work: workRun ? {
        status: workRun.status,
        pauseNote: workRun.pause_note,
        startedAt: apiTimestamp(workRun.started_at),
        updatedAt: apiTimestamp(workRun.updated_at),
        completedAt: apiTimestamp(workRun.completed_at),
        operations: this.db.prepare(`SELECT id, source, name, amount_minor, status, note, updated_at
          FROM order_work_operations WHERE order_id = ? AND tenant_id = ? ORDER BY sequence`).all(orderId, tenantId).map((operation) => ({
            id: operation.id,
            source: operation.source,
            name: operation.name,
            amountMinor: operation.amount_minor,
            status: operation.status,
            note: operation.note,
            updatedAt: apiTimestamp(operation.updated_at)
          }))
      } : null,
      qualityControl: this.db.prepare(`SELECT id, decision, responsible, note, created_at
        FROM qc_inspections WHERE order_id = ? AND tenant_id = ? ORDER BY created_at, rowid`).all(orderId, tenantId).map((inspection) => ({
          id: inspection.id,
          decision: inspection.decision,
          responsible: inspection.responsible,
          note: inspection.note,
          createdAt: apiTimestamp(inspection.created_at),
          checks: this.db.prepare(`SELECT code, label, passed FROM qc_check_items
            WHERE inspection_id = ? ORDER BY rowid`).all(inspection.id).map((check) => ({
              code: check.code, label: check.label, passed: Boolean(check.passed)
            }))
        })),
      handover: handover ? {
        responsible: handover.responsible,
        note: handover.note,
        handedOverAt: apiTimestamp(handover.handed_over_at)
      } : null,
      auditTrail: this.db.prepare(`SELECT event_type, metadata_json, occurred_at FROM order_audit_events
        WHERE order_id = ? AND tenant_id = ? ORDER BY occurred_at, rowid`).all(orderId, tenantId).map((event) => ({
          eventType: event.event_type,
          metadata: JSON.parse(event.metadata_json),
          occurredAt: apiTimestamp(event.occurred_at)
        })),
      documents: this.listOrderDocuments(tenantId, orderId)
    };
  }
};
