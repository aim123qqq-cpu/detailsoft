import { randomUUID, normalizeSearch, formatMoney, priceLabel, OPERATION_PRICE_CLASS, PACKAGE_PRICE_CLASS } from './shared.mjs';

/** Services, packages, operations and prices per vehicle class. Mixed into DetailFlowRepository (server/repository.mjs). */
export const catalogMethods = {
  getServicesCatalog(tenantId, vehicleId) {
    const vehicle = this.getVehiclePricingContext(tenantId, vehicleId);
    if (!vehicle) return { kind: 'not_found' };

    const services = this.db.prepare(`SELECT s.id, s.category, s.name, s.description, s.pricing_mode,
        COALESCE(SUM(p.amount_minor), 0) amount_minor,
        COALESCE(SUM(p.duration_minutes), 0) duration_minutes
      FROM tenant_services s
      LEFT JOIN tenant_service_operations so ON so.service_id = s.id
      LEFT JOIN service_operation_prices p
        ON p.service_id = so.service_id AND p.operation_id = so.operation_id AND p.tenant_class = ${OPERATION_PRICE_CLASS}
      WHERE s.tenant_id = ? AND s.active = 1
      GROUP BY s.id
      HAVING COUNT(so.operation_id) = COUNT(p.operation_id)
      ORDER BY s.category, s.name`).all(vehicle.tenant_class, tenantId).map((row) => ({
        id: row.id,
        type: 'service',
        category: row.category,
        name: row.name,
        description: row.description,
        pricingMode: row.pricing_mode,
        price: {
          amountMinor: row.amount_minor,
          label: priceLabel(row.amount_minor, row.pricing_mode)
        },
        durationMinutes: row.duration_minutes,
        operations: this.db.prepare(`SELECT o.id, o.name
          FROM tenant_service_operations so
          JOIN service_operations o ON o.id = so.operation_id
          WHERE so.service_id = ? ORDER BY so.sequence`).all(row.id)
      }));

    const packages = this.db.prepare(`SELECT p.id, p.category, p.name, p.description,
        pp.amount_minor, pp.duration_minutes
      FROM service_packages p
      JOIN service_package_prices pp ON pp.package_id = p.id AND pp.tenant_class = ${PACKAGE_PRICE_CLASS}
      WHERE p.tenant_id = ? AND p.active = 1
      ORDER BY p.category, p.name`).all(vehicle.tenant_class, tenantId).map((row) => ({
        id: row.id,
        type: 'package',
        category: row.category,
        name: row.name,
        description: row.description,
        pricingMode: 'fixed',
        price: { amountMinor: row.amount_minor, label: formatMoney(row.amount_minor) },
        durationMinutes: row.duration_minutes,
        operations: this.db.prepare(`SELECT o.id, o.name
          FROM service_package_operations po
          JOIN service_operations o ON o.id = po.operation_id
          WHERE po.package_id = ? ORDER BY po.sequence`).all(row.id)
      }));

    const categories = [];
    for (const item of [...packages, ...services]) {
      let category = categories.find((entry) => entry.name === item.category);
      if (!category) {
        category = { name: item.category, items: [] };
        categories.push(category);
      }
      category.items.push(item);
    }
    const order = this.catalog.sectionOrder(tenantId);
    categories.sort((left, right) => (order.get(left.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.name) ?? Number.MAX_SAFE_INTEGER));
    return { kind: 'found', vehicleClass: vehicle.tenant_class, categories };
  },

  /** Vehicle classes that get their own price rows; '*' alone when the center has no class rules. */
  pricingClasses(tenantId) {
    const classes = this.db.prepare(`SELECT DISTINCT tenant_class
      FROM tenant_vehicle_class_rules WHERE tenant_id = ?`).all(tenantId)
      .map((row) => row.tenant_class)
      .sort((left, right) => {
        const leftLatin = /^[A-Za-z]/.test(left);
        const rightLatin = /^[A-Za-z]/.test(right);
        return leftLatin === rightLatin ? left.localeCompare(right, 'ru') : leftLatin ? 1 : -1;
      });
    return classes.length ? classes : ['*'];
  },

  getManagedCatalog(tenantId) {
    const vehicleClasses = this.pricingClasses(tenantId);
    const services = this.db.prepare(`SELECT id, category, name, description, pricing_mode, active
      FROM tenant_services WHERE tenant_id = ? ORDER BY active DESC, category, name`).all(tenantId).map((service) => ({
        id: service.id,
        type: 'service',
        category: service.category,
        name: service.name,
        description: service.description,
        pricingMode: service.pricing_mode,
        active: Boolean(service.active),
        operations: this.db.prepare(`SELECT operation.id, operation.name
          FROM tenant_service_operations relation
          JOIN service_operations operation ON operation.id = relation.operation_id
          WHERE relation.service_id = ? AND operation.tenant_id = ?
          ORDER BY relation.sequence`).all(service.id, tenantId).map((operation) => ({
            id: operation.id,
            name: operation.name,
            prices: this.db.prepare(`SELECT tenant_class, amount_minor, duration_minutes
              FROM service_operation_prices
              WHERE service_id = ? AND operation_id = ? ORDER BY tenant_class`).all(service.id, operation.id).map((price) => ({
                tenantClass: price.tenant_class,
                amountMinor: price.amount_minor,
                durationMinutes: price.duration_minutes
              }))
          }))
      }));
    const packages = this.db.prepare(`SELECT id, category, name, description, active
      FROM service_packages WHERE tenant_id = ? ORDER BY active DESC, category, name`).all(tenantId).map((servicePackage) => ({
        id: servicePackage.id,
        type: 'package',
        category: servicePackage.category,
        name: servicePackage.name,
        description: servicePackage.description,
        pricingMode: 'fixed',
        active: Boolean(servicePackage.active),
        operations: this.db.prepare(`SELECT operation.id, operation.name
          FROM service_package_operations relation
          JOIN service_operations operation ON operation.id = relation.operation_id
          WHERE relation.package_id = ? AND operation.tenant_id = ?
          ORDER BY relation.sequence`).all(servicePackage.id, tenantId),
        prices: this.db.prepare(`SELECT tenant_class, amount_minor, duration_minutes
          FROM service_package_prices WHERE package_id = ? ORDER BY tenant_class`).all(servicePackage.id).map((price) => ({
            tenantClass: price.tenant_class,
            amountMinor: price.amount_minor,
            durationMinutes: price.duration_minutes
          }))
      }));
    const operationLibrary = this.db.prepare(`SELECT id, name, active
      FROM service_operations WHERE tenant_id = ? ORDER BY active DESC, name`).all(tenantId).map((operation) => ({
        id: operation.id,
        name: operation.name,
        active: Boolean(operation.active)
      }));
    // A service of one operation is "simple": edited as name + time + base price (+ class overrides).
    for (const service of services) {
      service.simple = service.operations.length === 1;
      if (!service.simple) continue;
      const prices = service.operations[0].prices;
      let base = prices.find((price) => price.tenantClass === '*') ?? null;
      let classPrices = prices.filter((price) => price.tenantClass !== '*');
      // Older services store the same price in every class row: that is one base price, not overrides.
      const same = (left, right) => left.amountMinor === right.amountMinor && left.durationMinutes === right.durationMinutes;
      if (!base && classPrices.length && classPrices.every((price) => same(price, classPrices[0]))) {
        base = classPrices[0];
        classPrices = [];
      }
      service.basePrice = base && { amountMinor: base.amountMinor, durationMinutes: base.durationMinutes };
      service.classPrices = base ? classPrices.filter((price) => !same(price, base)) : classPrices;
    }
    return { vehicleClasses, sections: this.catalog.listSections(tenantId), operationLibrary, items: [...packages, ...services] };
  },

  // SQLite lower() only folds ASCII, so names are compared with the same normalizer as search.
  findOperationByName(tenantId, name, excludeId = null) {
    const target = normalizeSearch(name);
    return this.db.prepare('SELECT id, name FROM service_operations WHERE tenant_id = ?').all(tenantId)
      .find((operation) => operation.id !== excludeId && normalizeSearch(operation.name) === target) ?? null;
  },

  listOperationLibrary(tenantId, query = '') {
    const usage = (sql) => this.db.prepare(sql).all(tenantId).reduce((map, row) => {
      const list = map.get(row.operation_id) ?? [];
      list.push({ id: row.id, name: row.name, active: row.active === 1 });
      map.set(row.operation_id, list);
      return map;
    }, new Map());
    const services = usage(`SELECT relation.operation_id, s.id, s.name, s.active FROM tenant_service_operations relation
      JOIN tenant_services s ON s.id = relation.service_id WHERE s.tenant_id = ? ORDER BY s.name`);
    const packages = usage(`SELECT relation.operation_id, p.id, p.name, p.active FROM service_package_operations relation
      JOIN service_packages p ON p.id = relation.package_id WHERE p.tenant_id = ? ORDER BY p.name`);
    const terms = normalizeSearch(query).split(' ').filter(Boolean);
    return this.db.prepare('SELECT id, name, active FROM service_operations WHERE tenant_id = ?').all(tenantId)
      .filter((operation) => terms.every((term) => normalizeSearch(operation.name).includes(term)))
      .map((operation) => {
        const usedBy = { services: services.get(operation.id) ?? [], packages: packages.get(operation.id) ?? [] };
        return {
          id: operation.id,
          name: operation.name,
          active: operation.active === 1,
          usage: { ...usedBy, activeCount: [...usedBy.services, ...usedBy.packages].filter((item) => item.active).length }
        };
      })
      .sort((left, right) => Number(right.active) - Number(left.active) || left.name.localeCompare(right.name, 'ru'));
  },

  /** Rename affects only future quotes (bookings and estimates store snapshots); archiving is refused while active items use it. */
  updateCatalogOperation(tenantId, operationId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { kind: 'invalid' };
    const keys = Object.keys(input);
    if (!keys.length || keys.some((key) => !['name', 'active'].includes(key))) return { kind: 'invalid' };
    const name = Object.hasOwn(input, 'name') ? (typeof input.name === 'string' ? input.name.trim() : null) : undefined;
    if (name === null || (name !== undefined && (name.length < 2 || name.length > 120))) return { kind: 'invalid' };
    if (Object.hasOwn(input, 'active') && typeof input.active !== 'boolean') return { kind: 'invalid' };
    const operation = this.db.prepare('SELECT id, name, active FROM service_operations WHERE id = ? AND tenant_id = ?').get(operationId, tenantId);
    if (!operation) return { kind: 'not_found' };
    if (name !== undefined && this.findOperationByName(tenantId, name, operationId)) return { kind: 'duplicate' };
    if (input.active === false && operation.active === 1) {
      const current = this.listOperationLibrary(tenantId).find((item) => item.id === operationId);
      const activeServices = current.usage.services.filter((item) => item.active);
      const activePackages = current.usage.packages.filter((item) => item.active);
      if (activeServices.length || activePackages.length) return {
        kind: 'conflict', code: 'operation_in_use',
        message: 'Операция входит в активные услуги или пакеты. Уберите её оттуда или переведите их в архив',
        details: { services: activeServices, packages: activePackages }
      };
    }
    this.db.prepare('UPDATE service_operations SET name = ?, active = ? WHERE id = ? AND tenant_id = ?').run(
      name ?? operation.name, input.active === undefined ? operation.active : Number(input.active), operationId, tenantId
    );
    return { kind: 'updated', operation: this.listOperationLibrary(tenantId).find((item) => item.id === operationId) };
  },

  createCatalogOperation(tenantId, input) {
    const name = String(input?.name ?? '').trim();
    if (name.length < 2 || name.length > 120) return { kind: 'invalid' };
    if (this.findOperationByName(tenantId, name)) return { kind: 'duplicate' };
    const operation = { id: `op_${randomUUID()}`, name, active: true };
    this.db.prepare(`INSERT INTO service_operations (id, tenant_id, name, active)
      VALUES (?, ?, ?, 1)`).run(operation.id, tenantId, name);
    return { kind: 'created', operation };
  },

  createManagedCatalogItem(tenantId, type, input) {
    if (!['service', 'package'].includes(type) || !input || typeof input !== 'object') return { kind: 'invalid' };
    const name = String(input.name ?? '').trim();
    const category = String(input.category ?? '').trim();
    const description = String(input.description ?? '').trim();
    const pricingMode = type === 'service' ? String(input.pricingMode ?? '') : 'fixed';
    const vehicleClasses = this.pricingClasses(tenantId);
    if (name.length < 2 || name.length > 120 || category.length < 2 || category.length > 80 ||
      description.length > 500 ||
      (type === 'service' && !['fixed', 'from', 'inspection'].includes(pricingMode))) return { kind: 'invalid' };

    let operationIds;
    let operationPrices = [];
    let amountMinor;
    let durationMinutes;
    if (type === 'service') {
      if (!Array.isArray(input.operationPrices) || !input.operationPrices.length || input.operationPrices.length > 50) return { kind: 'invalid' };
      operationPrices = input.operationPrices.map((price) => ({
        operationId: String(price?.operationId ?? ''),
        amountMinor: Number(price?.amountMinor),
        durationMinutes: Number(price?.durationMinutes)
      }));
      operationIds = operationPrices.map((price) => price.operationId);
      if (new Set(operationIds).size !== operationIds.length || operationPrices.some((price) =>
        !Number.isInteger(price.amountMinor) || price.amountMinor < 0 || price.amountMinor > 100_000_000 ||
        !Number.isInteger(price.durationMinutes) || price.durationMinutes < 1 || price.durationMinutes > 1440)) return { kind: 'invalid' };
    } else {
      if (!Array.isArray(input.operationIds) || !input.operationIds.length || input.operationIds.length > 50) return { kind: 'invalid' };
      operationIds = [...new Set(input.operationIds.map((id) => String(id)))];
      amountMinor = Number(input.amountMinor);
      durationMinutes = Number(input.durationMinutes);
      if (operationIds.length !== input.operationIds.length || !Number.isInteger(amountMinor) || amountMinor < 0 || amountMinor > 100_000_000 ||
        !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) return { kind: 'invalid' };
    }
    const placeholders = operationIds.map(() => '?').join(',');
    const operationCount = this.db.prepare(`SELECT COUNT(*) count FROM service_operations
      WHERE tenant_id = ? AND active = 1 AND id IN (${placeholders})`).get(tenantId, ...operationIds).count;
    if (operationCount !== operationIds.length) return { kind: 'invalid' };

    const itemId = `${type === 'service' ? 'service' : 'package'}_${randomUUID()}`;
    this.db.exec('BEGIN');
    try {
      if (type === 'service') {
        this.db.prepare(`INSERT INTO tenant_services
          (id, tenant_id, category, name, description, pricing_mode, active)
          VALUES (?, ?, ?, ?, ?, ?, 1)`).run(itemId, tenantId, category, name, description, pricingMode);
        const insertRelation = this.db.prepare(`INSERT INTO tenant_service_operations
          (service_id, operation_id, sequence) VALUES (?, ?, ?)`);
        const insertPrice = this.db.prepare(`INSERT INTO service_operation_prices
          (service_id, operation_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?, ?)`);
        operationPrices.forEach((price, index) => {
          insertRelation.run(itemId, price.operationId, index + 1);
          for (const tenantClass of vehicleClasses) insertPrice.run(
            itemId, price.operationId, tenantClass, price.amountMinor, price.durationMinutes
          );
        });
      } else {
        this.db.prepare(`INSERT INTO service_packages
          (id, tenant_id, category, name, description, active) VALUES (?, ?, ?, ?, ?, 1)`)
          .run(itemId, tenantId, category, name, description);
        const insertRelation = this.db.prepare(`INSERT INTO service_package_operations
          (package_id, operation_id, sequence) VALUES (?, ?, ?)`);
        operationIds.forEach((operationId, index) => insertRelation.run(itemId, operationId, index + 1));
        const insertPrice = this.db.prepare(`INSERT INTO service_package_prices
          (package_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?)`);
        for (const tenantClass of vehicleClasses) insertPrice.run(itemId, tenantClass, amountMinor, durationMinutes);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { kind: 'created', item: this.getManagedCatalog(tenantId).items.find((item) => item.id === itemId) };
  },

  updateManagedCatalogItem(tenantId, type, itemId, input) {
    if (!['service', 'package'].includes(type) || typeof input !== 'object' || !input) return { kind: 'invalid' };
    const name = String(input.name ?? '').trim();
    const category = String(input.category ?? '').trim();
    const description = String(input.description ?? '').trim();
    const active = input.active;
    const prices = input.prices;
    const pricingMode = type === 'service' ? String(input.pricingMode ?? '') : 'fixed';
    const operationIds = input.operationIds === undefined ? null
      : Array.isArray(input.operationIds) ? [...new Set(input.operationIds.map((id) => String(id)))] : [];
    if (name.length < 2 || name.length > 120 || category.length < 2 || category.length > 80 ||
      description.length > 500 || typeof active !== 'boolean' || !Array.isArray(prices) || prices.length > 100 ||
      (type === 'service' && !['fixed', 'from', 'inspection'].includes(pricingMode)) ||
      (operationIds && (!operationIds.length || operationIds.length > 50 || operationIds.length !== input.operationIds.length))) return { kind: 'invalid' };

    const table = type === 'service' ? 'tenant_services' : 'service_packages';
    const item = this.db.prepare(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`).get(itemId, tenantId);
    if (!item) return { kind: 'not_found' };
    if (active) {
      // An item cannot return to sale while it still contains an archived operation.
      const composition = operationIds ?? this.db.prepare(type === 'service'
        ? 'SELECT operation_id id FROM tenant_service_operations WHERE service_id = ?'
        : 'SELECT operation_id id FROM service_package_operations WHERE package_id = ?').all(itemId).map((row) => row.id);
      const archived = composition.length ? this.db.prepare(`SELECT name FROM service_operations
        WHERE tenant_id = ? AND active = 0 AND id IN (${composition.map(() => '?').join(',')})`).all(tenantId, ...composition) : [];
      if (archived.length) return {
        kind: 'conflict', code: 'operation_archived',
        message: `В составе есть архивные операции: ${archived.map((row) => row.name).join(', ')}. Восстановите их или уберите из состава`
      };
    }
    if (operationIds) {
      const placeholders = operationIds.map(() => '?').join(',');
      const operationCount = this.db.prepare(`SELECT COUNT(*) count FROM service_operations
        WHERE tenant_id = ? AND active = 1 AND id IN (${placeholders})`).get(tenantId, ...operationIds).count;
      if (operationCount !== operationIds.length) return { kind: 'invalid' };
    }
    const allowedClasses = new Set([...this.pricingClasses(tenantId), '*']);
    const normalizedPrices = [];
    for (const price of prices) {
      const tenantClass = String(price?.tenantClass ?? '');
      const amountMinor = Number(price?.amountMinor);
      const durationMinutes = Number(price?.durationMinutes);
      if (!allowedClasses.has(tenantClass) || !Number.isInteger(amountMinor) || amountMinor < 0 || amountMinor > 100_000_000 ||
        !Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) return { kind: 'invalid' };
      if (type === 'service') {
        const operationId = String(price?.operationId ?? '');
        const allowedOperation = operationIds
          ? operationIds.includes(operationId)
          : Boolean(this.db.prepare(`SELECT 1 FROM tenant_service_operations relation
              JOIN service_operations operation ON operation.id = relation.operation_id
              WHERE relation.service_id = ? AND relation.operation_id = ? AND operation.tenant_id = ?`).get(itemId, operationId, tenantId));
        if (!allowedOperation) return { kind: 'invalid' };
        normalizedPrices.push({ operationId, tenantClass, amountMinor, durationMinutes });
      } else {
        normalizedPrices.push({ tenantClass, amountMinor, durationMinutes });
      }
    }
    if (type === 'service' && operationIds && operationIds.some((operationId) =>
      !normalizedPrices.some((price) => price.operationId === operationId) &&
      !this.db.prepare(`SELECT 1 FROM service_operation_prices
        WHERE service_id = ? AND operation_id = ? LIMIT 1`).get(itemId, operationId))) return { kind: 'invalid' };

    this.db.exec('BEGIN');
    try {
      if (type === 'service') {
        this.db.prepare(`UPDATE tenant_services SET category = ?, name = ?, description = ?, pricing_mode = ?, active = ?
          WHERE id = ? AND tenant_id = ?`).run(category, name, description, pricingMode, Number(active), itemId, tenantId);
        const updatePrice = this.db.prepare(`INSERT INTO service_operation_prices
          (service_id, operation_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(service_id, operation_id, tenant_class) DO UPDATE SET
            amount_minor = excluded.amount_minor, duration_minutes = excluded.duration_minutes`);
        for (const price of normalizedPrices) updatePrice.run(
          itemId, price.operationId, price.tenantClass, price.amountMinor, price.durationMinutes
        );
        if (operationIds) {
          this.db.prepare('DELETE FROM tenant_service_operations WHERE service_id = ?').run(itemId);
          const insertRelation = this.db.prepare(`INSERT INTO tenant_service_operations
            (service_id, operation_id, sequence) VALUES (?, ?, ?)`);
          operationIds.forEach((operationId, index) => insertRelation.run(itemId, operationId, index + 1));
          const selectedPlaceholders = operationIds.map(() => '?').join(',');
          this.db.prepare(`DELETE FROM service_operation_prices
            WHERE service_id = ? AND operation_id NOT IN (${selectedPlaceholders})`).run(itemId, ...operationIds);
          for (const operationId of operationIds) {
            const seed = normalizedPrices.find((price) => price.operationId === operationId) ??
              this.db.prepare(`SELECT operation_id operationId, amount_minor amountMinor, duration_minutes durationMinutes
                FROM service_operation_prices WHERE service_id = ? AND operation_id = ? LIMIT 1`).get(itemId, operationId);
            if (!seed) throw new Error('missing_operation_price');
            for (const tenantClass of allowedClasses) this.db.prepare(`INSERT INTO service_operation_prices
              (service_id, operation_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(service_id, operation_id, tenant_class) DO NOTHING`).run(
                itemId, operationId, tenantClass, seed.amountMinor, seed.durationMinutes
              );
          }
        }
      } else {
        this.db.prepare(`UPDATE service_packages SET category = ?, name = ?, description = ?, active = ?
          WHERE id = ? AND tenant_id = ?`).run(category, name, description, Number(active), itemId, tenantId);
        const updatePrice = this.db.prepare(`INSERT INTO service_package_prices
          (package_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?)
          ON CONFLICT(package_id, tenant_class) DO UPDATE SET
            amount_minor = excluded.amount_minor, duration_minutes = excluded.duration_minutes`);
        for (const price of normalizedPrices) updatePrice.run(
          itemId, price.tenantClass, price.amountMinor, price.durationMinutes
        );
        if (operationIds) {
          this.db.prepare('DELETE FROM service_package_operations WHERE package_id = ?').run(itemId);
          const insertRelation = this.db.prepare(`INSERT INTO service_package_operations
            (package_id, operation_id, sequence) VALUES (?, ?, ?)`);
          operationIds.forEach((operationId, index) => insertRelation.run(itemId, operationId, index + 1));
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      kind: 'updated',
      item: this.getManagedCatalog(tenantId).items.find((catalogItem) => catalogItem.id === itemId)
    };
  }
};
