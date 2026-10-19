import { randomUUID } from 'node:crypto';
import { normalizeSearch } from './domain/normalize.mjs';

const MAX_AMOUNT_MINOR = 100_000_000;
const PRICING_MODES = ['fixed', 'from', 'inspection'];

function cleanPrice(price) {
  const amountMinor = Number(price?.amountMinor);
  const durationMinutes = Number(price?.durationMinutes);
  if (!Number.isInteger(amountMinor) || amountMinor < 0 || amountMinor > MAX_AMOUNT_MINOR ||
    !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) return null;
  return { amountMinor, durationMinutes };
}

/**
 * Catalog sections and "simple" services (one name, one time, one price — or a price per vehicle
 * class). A simple service is an ordinary service with exactly one operation, created behind the
 * scenes, so bookings, estimates and work tracking need no special case.
 */
export class CatalogRepository {
  constructor(db, repository) {
    this.db = db;
    this.repository = repository;
  }

  /** Sections in their order; categories used by items but missing as sections are added at the end. */
  listSections(tenantId) {
    this.#syncSections(tenantId);
    const counts = (table) => new Map(this.db.prepare(`SELECT category, COUNT(*) total, SUM(active) active
      FROM ${table} WHERE tenant_id = ? GROUP BY category`).all(tenantId).map((row) => [row.category, row]));
    const services = counts('tenant_services');
    const packages = counts('service_packages');
    return this.db.prepare('SELECT id, name, position FROM catalog_sections WHERE tenant_id = ? ORDER BY position, name')
      .all(tenantId).map((row) => ({
        id: row.id,
        name: row.name,
        position: row.position,
        itemCount: (services.get(row.name)?.total ?? 0) + (packages.get(row.name)?.total ?? 0),
        activeCount: (services.get(row.name)?.active ?? 0) + (packages.get(row.name)?.active ?? 0)
      }));
  }

  createSection(tenantId, input) {
    const name = String(input?.name ?? '').trim();
    if (name.length < 2 || name.length > 80) return { kind: 'invalid' };
    if (this.#sectionByName(tenantId, name)) return { kind: 'conflict', code: 'section_exists', message: 'Раздел с таким названием уже есть' };
    const position = (this.db.prepare('SELECT MAX(position) value FROM catalog_sections WHERE tenant_id = ?').get(tenantId).value ?? 0) + 1;
    const id = `section_${randomUUID()}`;
    this.db.prepare('INSERT INTO catalog_sections (id, tenant_id, name, position) VALUES (?, ?, ?, ?)').run(id, tenantId, name, position);
    return { kind: 'created', section: this.listSections(tenantId).find((section) => section.id === id) };
  }

  /** Renaming moves the section's items with it; bookings and estimates keep their own snapshots. */
  renameSection(tenantId, sectionId, input) {
    const name = String(input?.name ?? '').trim();
    if (name.length < 2 || name.length > 80) return { kind: 'invalid' };
    const section = this.db.prepare('SELECT id, name FROM catalog_sections WHERE id = ? AND tenant_id = ?').get(sectionId, tenantId);
    if (!section) return { kind: 'not_found' };
    const clash = this.#sectionByName(tenantId, name);
    if (clash && clash.id !== sectionId) return { kind: 'conflict', code: 'section_exists', message: 'Раздел с таким названием уже есть' };
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE catalog_sections SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, sectionId);
      for (const table of ['tenant_services', 'service_packages']) {
        this.db.prepare(`UPDATE ${table} SET category = ? WHERE tenant_id = ? AND category = ?`).run(name, tenantId, section.name);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', section: this.listSections(tenantId).find((item) => item.id === sectionId) };
  }

  /** The new order must list every section of the center exactly once. */
  reorderSections(tenantId, input) {
    const ids = Array.isArray(input?.ids) ? input.ids.map(String) : null;
    const current = this.listSections(tenantId).map((section) => section.id);
    if (!ids || ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !current.includes(id))) {
      return { kind: 'invalid' };
    }
    this.db.exec('BEGIN');
    try {
      const update = this.db.prepare('UPDATE catalog_sections SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND tenant_id = ?');
      ids.forEach((id, index) => update.run(index + 1, id, tenantId));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', sections: this.listSections(tenantId) };
  }

  /** Only an empty section can be removed: archived items still belong to it and stay in history. */
  deleteSection(tenantId, sectionId) {
    const section = this.listSections(tenantId).find((item) => item.id === sectionId);
    if (!section) return { kind: 'not_found' };
    if (section.itemCount > 0) {
      return { kind: 'conflict', code: 'section_not_empty', message: `В разделе есть позиции (${section.itemCount}), в том числе архивные. Перенесите их в другой раздел` };
    }
    this.db.prepare('DELETE FROM catalog_sections WHERE id = ? AND tenant_id = ?').run(sectionId, tenantId);
    return { kind: 'deleted' };
  }

  /** Index of section positions by name, used to order catalog groups for booking. */
  sectionOrder(tenantId) {
    return new Map(this.listSections(tenantId).map((section) => [section.name, section.position]));
  }

  createSimpleService(tenantId, input) {
    const parsed = this.#parseSimple(tenantId, input);
    if (parsed.kind !== 'valid') return parsed;
    const { name, section, description, pricingMode, basePrice, classPrices } = parsed;
    if (this.#activeServiceNamed(tenantId, name)) return { kind: 'conflict', code: 'service_exists', message: 'Активная услуга с таким названием уже есть' };
    const existing = this.repository.findOperationByName(tenantId, name);
    if (existing && !this.db.prepare('SELECT active FROM service_operations WHERE id = ?').get(existing.id).active) {
      return { kind: 'conflict', code: 'operation_archived', message: `Операция «${existing.name}» в архиве. Восстановите её во вкладке «Операции» или выберите другое название` };
    }
    const serviceId = `service_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      const operationId = existing?.id ?? `op_${randomUUID()}`;
      if (!existing) this.db.prepare('INSERT INTO service_operations (id, tenant_id, name, active) VALUES (?, ?, ?, 1)').run(operationId, tenantId, name);
      this.db.prepare(`INSERT INTO tenant_services (id, tenant_id, category, name, description, pricing_mode, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)`).run(serviceId, tenantId, section.name, name, description, pricingMode);
      this.db.prepare('INSERT INTO tenant_service_operations (service_id, operation_id, sequence) VALUES (?, ?, 1)').run(serviceId, operationId);
      this.#writePrices(serviceId, operationId, basePrice, classPrices);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', item: this.#managedItem(tenantId, serviceId) };
  }

  /**
   * Edits a simple service. Its hidden operation follows the new name when no other service or
   * package uses it; otherwise the operation keeps its name so other items are not renamed.
   */
  updateSimpleService(tenantId, serviceId, input) {
    const service = this.db.prepare('SELECT id, name, active FROM tenant_services WHERE id = ? AND tenant_id = ?').get(serviceId, tenantId);
    if (!service) return { kind: 'not_found' };
    const operations = this.db.prepare('SELECT operation_id id FROM tenant_service_operations WHERE service_id = ?').all(serviceId);
    if (operations.length !== 1) return { kind: 'conflict', code: 'service_not_simple', message: 'Услуга собрана из нескольких операций. Измените её в редакторе состава' };
    const parsed = this.#parseSimple(tenantId, input);
    if (parsed.kind !== 'valid') return parsed;
    if (typeof input.active !== 'boolean') return { kind: 'invalid' };
    const { name, section, description, pricingMode, basePrice, classPrices } = parsed;
    const operationId = operations[0].id;
    const operation = this.db.prepare('SELECT id, name, active FROM service_operations WHERE id = ? AND tenant_id = ?').get(operationId, tenantId);
    if (input.active && !operation.active) {
      return { kind: 'conflict', code: 'operation_archived', message: `Операция «${operation.name}» в архиве. Восстановите её во вкладке «Операции»` };
    }
    if (input.active && normalizeSearch(name) !== normalizeSearch(service.name) && this.#activeServiceNamed(tenantId, name, serviceId)) {
      return { kind: 'conflict', code: 'service_exists', message: 'Активная услуга с таким названием уже есть' };
    }
    const sharedElsewhere = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM tenant_service_operations WHERE operation_id = ? AND service_id <> ?) +
        (SELECT COUNT(*) FROM service_package_operations WHERE operation_id = ?) count`).get(operationId, serviceId, operationId).count > 0;
    const renameOperation = !sharedElsewhere && operation.name !== name && !this.repository.findOperationByName(tenantId, name, operationId);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE tenant_services SET category = ?, name = ?, description = ?, pricing_mode = ?, active = ?
        WHERE id = ? AND tenant_id = ?`).run(section.name, name, description, pricingMode, Number(input.active), serviceId, tenantId);
      if (renameOperation) this.db.prepare('UPDATE service_operations SET name = ? WHERE id = ? AND tenant_id = ?').run(name, operationId, tenantId);
      this.db.prepare('DELETE FROM service_operation_prices WHERE service_id = ? AND operation_id = ?').run(serviceId, operationId);
      this.#writePrices(serviceId, operationId, basePrice, classPrices);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'updated', item: this.#managedItem(tenantId, serviceId) };
  }

  #parseSimple(tenantId, input) {
    if (!input || typeof input !== 'object') return { kind: 'invalid' };
    const name = String(input.name ?? '').trim();
    const description = String(input.description ?? '').trim();
    const pricingMode = String(input.pricingMode ?? 'fixed');
    const basePrice = cleanPrice(input.basePrice);
    if (name.length < 2 || name.length > 120 || description.length > 500 || !PRICING_MODES.includes(pricingMode) || !basePrice) return { kind: 'invalid' };
    const section = this.listSections(tenantId).find((item) => item.id === input.sectionId);
    if (!section) return { kind: 'invalid', code: 'section_required' };
    // Per-class prices are optional overrides of the base price and only for the center's classes.
    const known = new Set(this.repository.pricingClasses(tenantId).filter((value) => value !== '*'));
    const rawClassPrices = input.classPrices ?? [];
    if (!Array.isArray(rawClassPrices) || rawClassPrices.length > known.size) return { kind: 'invalid' };
    const classPrices = [];
    for (const raw of rawClassPrices) {
      const tenantClass = String(raw?.tenantClass ?? '');
      const price = cleanPrice(raw);
      if (!known.has(tenantClass) || !price || classPrices.some((item) => item.tenantClass === tenantClass)) return { kind: 'invalid' };
      classPrices.push({ tenantClass, ...price });
    }
    return { kind: 'valid', name, section, description, pricingMode, basePrice, classPrices };
  }

  #writePrices(serviceId, operationId, basePrice, classPrices) {
    const insert = this.db.prepare(`INSERT INTO service_operation_prices
      (service_id, operation_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?, ?)`);
    insert.run(serviceId, operationId, '*', basePrice.amountMinor, basePrice.durationMinutes);
    for (const price of classPrices) insert.run(serviceId, operationId, price.tenantClass, price.amountMinor, price.durationMinutes);
  }

  #managedItem(tenantId, serviceId) {
    return this.repository.getManagedCatalog(tenantId).items.find((item) => item.id === serviceId);
  }

  #activeServiceNamed(tenantId, name, excludeId = null) {
    const target = normalizeSearch(name);
    return this.db.prepare('SELECT id, name FROM tenant_services WHERE tenant_id = ? AND active = 1').all(tenantId)
      .some((service) => service.id !== excludeId && normalizeSearch(service.name) === target);
  }

  #sectionByName(tenantId, name) {
    const target = normalizeSearch(name);
    return this.db.prepare('SELECT id, name FROM catalog_sections WHERE tenant_id = ?').all(tenantId)
      .find((section) => normalizeSearch(section.name) === target) ?? null;
  }

  #syncSections(tenantId) {
    const categories = this.db.prepare(`SELECT category FROM tenant_services WHERE tenant_id = ?
      UNION SELECT category FROM service_packages WHERE tenant_id = ? ORDER BY 1`).all(tenantId, tenantId).map((row) => row.category);
    const existing = new Set(this.db.prepare('SELECT name FROM catalog_sections WHERE tenant_id = ?').all(tenantId).map((row) => row.name));
    const missing = categories.filter((category) => !existing.has(category));
    if (!missing.length) return;
    let position = this.db.prepare('SELECT MAX(position) value FROM catalog_sections WHERE tenant_id = ?').get(tenantId).value ?? 0;
    const insert = this.db.prepare('INSERT OR IGNORE INTO catalog_sections (id, tenant_id, name, position) VALUES (?, ?, ?, ?)');
    for (const category of missing) insert.run(`section_${randomUUID()}`, tenantId, category, ++position);
  }
}
