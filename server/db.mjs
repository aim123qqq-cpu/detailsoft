import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));

export function openDatabase(databasePath, { seed = false } = {}) {
  const db = new DatabaseSync(databasePath, { timeout: 2_000 });
  db.exec(readFileSync(resolve(here, '../migrations/001_customer_vehicle.sql'), 'utf8'));
  if (seed) seedDatabase(db);
  return db;
}

function insertMany(db, sql, rows) {
  const statement = db.prepare(sql);
  for (const row of rows) statement.run(...row);
}

export function seedDatabase(db) {
  db.exec('BEGIN');
  try {
    insertMany(db, 'INSERT OR IGNORE INTO tenants (id, name) VALUES (?, ?)', [
      ['tenant_demo', 'DetailFlow Studio'],
      ['tenant_other', 'Другой центр']
    ]);
    insertMany(db, `INSERT OR IGNORE INTO vehicle_catalog_variants
      (id, make, model, generation, year_from, year_to, body_type, system_vehicle_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      ['variant_mazda_3_bl_sedan', 'Mazda', '3', 'BL', 2009, 2013, 'sedan', 'M'],
      ['variant_mazda_3_bl_hatch', 'Mazda', '3', 'BL', 2009, 2013, 'hatchback', 'C'],
      ['variant_camry_xv70', 'Toyota', 'Camry', 'XV70', 2017, 2024, 'sedan', 'L'],
      ['variant_bmw_x5_g05', 'BMW', 'X5', 'G05', 2018, 2026, 'suv', 'XL']
    ]);
    insertMany(db, `INSERT OR IGNORE INTO customers
      (id, tenant_id, name, phone_display, phone_normalized, visit_count)
      VALUES (?, ?, ?, ?, ?, ?)`, [
      ['cust_alexey', 'tenant_demo', 'Алексей Морозов', '+7 913 123-45-67', '79131234567', 6],
      ['cust_other', 'tenant_other', 'Скрытый клиент', '+7 913 123-45-67', '79131234567', 2]
    ]);
    insertMany(db, `INSERT OR IGNORE INTO vehicles
      (id, tenant_id, catalog_variant_id, make, model, generation, body_type,
       plate_display, plate_normalized, color, system_vehicle_class, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      ['veh_mazda', 'tenant_demo', 'variant_mazda_3_bl_sedan', 'Mazda', '3', 'BL', 'sedan', 'А123АА 55', 'А123АА55', 'серебристый', 'M', 'active'],
      ['veh_camry', 'tenant_demo', 'variant_camry_xv70', 'Toyota', 'Camry', 'XV70', 'sedan', 'В476РЕ 155', 'В476РЕ155', 'чёрный', 'L', 'active'],
      ['veh_other', 'tenant_other', 'variant_mazda_3_bl_sedan', 'Mazda', '3', 'BL', 'sedan', 'А123АА 55', 'А123АА55', 'синий', 'M', 'active']
    ]);
    insertMany(db, `INSERT OR IGNORE INTO customer_vehicles
      (id, tenant_id, customer_id, vehicle_id, relation_type, is_primary)
      VALUES (?, ?, ?, ?, 'owner', 1)`, [
      ['link_alexey_mazda', 'tenant_demo', 'cust_alexey', 'veh_mazda'],
      ['link_alexey_camry', 'tenant_demo', 'cust_alexey', 'veh_camry'],
      ['link_other', 'tenant_other', 'cust_other', 'veh_other']
    ]);
    insertMany(db, `INSERT OR IGNORE INTO tenant_vehicle_class_rules
      (id, tenant_id, variant_id, class_match, tenant_class, priority)
      VALUES (?, ?, ?, ?, ?, ?)`, [
      ['rule_demo_mazda_sedan', 'tenant_demo', 'variant_mazda_3_bl_sedan', null, 'Средний', 100],
      ['rule_demo_mazda_hatch', 'tenant_demo', 'variant_mazda_3_bl_hatch', null, 'Компакт', 100],
      ['rule_demo_camry', 'tenant_demo', 'variant_camry_xv70', null, 'Бизнес', 100]
    ]);
    db.prepare(`INSERT OR IGNORE INTO orders
      (id, tenant_id, customer_id, vehicle_id, status)
      VALUES (?, ?, ?, ?, ?)`)
      .run('order_history_1', 'tenant_demo', 'cust_alexey', 'veh_mazda', 'CLOSED');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
