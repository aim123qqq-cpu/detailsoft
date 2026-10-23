import { RolesRepository } from './roles-repository.mjs';
import { CatalogRepository } from './catalog-repository.mjs';
import { centerMethods } from './repository/center.mjs';
import { leadsMethods } from './repository/leads.mjs';
import { customersMethods } from './repository/customers.mjs';
import { vehiclesMethods } from './repository/vehicles.mjs';
import { catalogMethods } from './repository/catalog.mjs';
import { bookingsMethods } from './repository/bookings.mjs';
import { ordersMethods } from './repository/orders.mjs';
import { analyticsMethods } from './repository/analytics.mjs';

/**
 * Data access for one DetailFlow database. Methods live in server/repository/<domain>.mjs and are
 * mixed in here, so callers keep using a single repository object.
 */
export class DetailFlowRepository {
  constructor(db) {
    this.db = db;
    this.roles = new RolesRepository(db);
    this.catalog = new CatalogRepository(db, this);
  }

  getTenant(tenantId) {
    const tenant = this.db.prepare('SELECT id, name, timezone FROM tenants WHERE id = ?').get(tenantId);
    return tenant ? { id: tenant.id, name: tenant.name, timezone: tenant.timezone, requisites: this.getTenantRequisites(tenantId) } : null;
  }
}

Object.assign(DetailFlowRepository.prototype, centerMethods, leadsMethods, customersMethods, vehiclesMethods, catalogMethods, bookingsMethods, ordersMethods, analyticsMethods);
