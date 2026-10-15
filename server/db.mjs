import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));

export function openDatabase(databasePath, { seed = false } = {}) {
  const db = new DatabaseSync(databasePath, { timeout: 2_000 });
  const migrationsDirectory = resolve(here, '../migrations');
  for (const migration of readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(resolve(migrationsDirectory, migration), 'utf8'));
  }
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
    insertMany(db, `INSERT OR IGNORE INTO leads
      (id, tenant_id, customer_id, channel, status, contact_name, phone_display, phone_normalized, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      ['lead_demo_telegram', 'tenant_demo', 'cust_alexey', 'telegram', 'NEW', 'Алексей Морозов', '+7 913 123-45-67', '79131234567', 'Уточнить стоимость керамики кузова'],
      ['lead_demo_call', 'tenant_demo', null, 'call', 'CONTACTED', 'Марина', '+7 999 204-18-90', '79992041890', 'Перезвонить после 18:00']
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
      ['rule_demo_camry', 'tenant_demo', 'variant_camry_xv70', null, 'Бизнес', 100],
      ['rule_demo_bmw', 'tenant_demo', 'variant_bmw_x5_g05', null, 'SUV', 100]
    ]);
    insertMany(db, `INSERT OR IGNORE INTO service_operations
      (id, tenant_id, name) VALUES (?, ?, ?)`, [
      ['op_prewash', 'tenant_demo', 'Предварительная мойка'],
      ['op_handwash', 'tenant_demo', 'Ручная мойка кузова'],
      ['op_dry', 'tenant_demo', 'Сушка кузова'],
      ['op_rims', 'tenant_demo', 'Очистка дисков'],
      ['op_vacuum', 'tenant_demo', 'Пылесос салона'],
      ['op_dashboard', 'tenant_demo', 'Уход за пластиком'],
      ['op_polish', 'tenant_demo', 'Одношаговая полировка']
    ]);
    insertMany(db, `INSERT OR IGNORE INTO tenant_services
      (id, tenant_id, category, name, description, pricing_mode)
      VALUES (?, ?, ?, ?, ?, ?)`, [
      ['service_wash', 'tenant_demo', 'Мойка и уход', 'Бережная мойка', 'Трёхфазный уход за кузовом без агрессивной химии', 'fixed'],
      ['service_wheels', 'tenant_demo', 'Мойка и уход', 'Детейлинг дисков', 'Глубокая очистка лицевой стороны дисков', 'fixed'],
      ['service_interior', 'tenant_demo', 'Салон', 'Экспресс-уход за салоном', 'Пылесос и уход за основными поверхностями', 'fixed'],
      ['service_polish', 'tenant_demo', 'Детейлинг кузова', 'Одношаговая полировка', 'Возвращает блеск и убирает лёгкие риски', 'from']
    ]);
    insertMany(db, `INSERT OR IGNORE INTO tenant_service_operations
      (service_id, operation_id, sequence) VALUES (?, ?, ?)`, [
      ['service_wash', 'op_prewash', 1], ['service_wash', 'op_handwash', 2], ['service_wash', 'op_dry', 3],
      ['service_wheels', 'op_rims', 1],
      ['service_interior', 'op_vacuum', 1], ['service_interior', 'op_dashboard', 2],
      ['service_polish', 'op_polish', 1]
    ]);
    const classMultipliers = [['Компакт', 0.85], ['Средний', 1], ['Бизнес', 1.2], ['SUV', 1.4]];
    const operationBasePrices = [
      ['service_wash', 'op_prewash', 30000, 8],
      ['service_wash', 'op_handwash', 80000, 18],
      ['service_wash', 'op_dry', 30000, 9],
      ['service_wheels', 'op_rims', 60000, 15],
      ['service_interior', 'op_vacuum', 90000, 25],
      ['service_interior', 'op_dashboard', 70000, 20],
      ['service_polish', 'op_polish', 800000, 180]
    ];
    const operationPriceRows = [];
    for (const [tenantClass, multiplier] of classMultipliers) {
      for (const [serviceId, operationId, amountMinor, durationMinutes] of operationBasePrices) {
        operationPriceRows.push([serviceId, operationId, tenantClass, Math.round(amountMinor * multiplier), durationMinutes]);
      }
    }
    insertMany(db, `INSERT OR IGNORE INTO service_operation_prices
      (service_id, operation_id, tenant_class, amount_minor, duration_minutes)
      VALUES (?, ?, ?, ?, ?)`, operationPriceRows);
    db.prepare(`INSERT OR IGNORE INTO service_packages
      (id, tenant_id, category, name, description)
      VALUES (?, ?, ?, ?, ?)`).run(
        'package_complex', 'tenant_demo', 'Комплексы', 'Комплексный уход',
        'Кузов, диски и салон в одном визите'
      );
    db.prepare(`INSERT OR IGNORE INTO service_packages
      (id, tenant_id, category, name, description)
      VALUES (?, ?, ?, ?, ?)`).run(
        'package_interior', 'tenant_demo', 'Комплексы', 'Салон Fresh',
        'Пылесос и уход за интерьером'
      );
    insertMany(db, `INSERT OR IGNORE INTO service_package_operations
      (package_id, operation_id, sequence) VALUES (?, ?, ?)`, [
      ['package_complex', 'op_prewash', 1], ['package_complex', 'op_handwash', 2],
      ['package_complex', 'op_dry', 3], ['package_complex', 'op_rims', 4],
      ['package_complex', 'op_vacuum', 5], ['package_complex', 'op_dashboard', 6],
      ['package_interior', 'op_vacuum', 1], ['package_interior', 'op_dashboard', 2]
    ]);
    insertMany(db, `INSERT OR IGNORE INTO service_package_prices
      (package_id, tenant_class, amount_minor, duration_minutes) VALUES (?, ?, ?, ?)`, [
      ['package_complex', 'Компакт', 420000, 110],
      ['package_complex', 'Средний', 490000, 120],
      ['package_complex', 'Бизнес', 590000, 135],
      ['package_complex', 'SUV', 690000, 150],
      ['package_interior', 'Компакт', 120000, 40],
      ['package_interior', 'Средний', 140000, 45],
      ['package_interior', 'Бизнес', 170000, 50],
      ['package_interior', 'SUV', 190000, 55]
    ]);
    insertMany(db, `INSERT OR IGNORE INTO tenant_booking_settings
      (tenant_id, simultaneous_capacity) VALUES (?, ?)`, [
      ['tenant_demo', 2], ['tenant_other', 1]
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
