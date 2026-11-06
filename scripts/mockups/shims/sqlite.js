// For the browser build of mockups only: the offline copy lives in memory, for the few statements offline-store.ts uses.
const rows = new Map();
const database = {
  async execAsync() {},
  async getFirstAsync(_sql, store, key) { const value = rows.get(`${store}|${key}`); return value === undefined ? null : { value }; },
  async runAsync(sql, store, key, value) {
    if (sql.startsWith('INSERT')) rows.set(`${store}|${key}`, value);
    else if (sql.includes('store = ?')) rows.delete(`${store}|${key}`);
    else rows.clear();
  },
  async getAllAsync(_sql, store) {
    return [...rows].filter(([id]) => id.startsWith(`${store}|`)).map(([id, value]) => ({ key: id.slice(store.length + 1), value })).sort((a, b) => a.key.localeCompare(b.key));
  }
};
export const openDatabaseAsync = async () => database;
