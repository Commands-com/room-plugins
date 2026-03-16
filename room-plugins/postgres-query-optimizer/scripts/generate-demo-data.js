#!/usr/bin/env node
/**
 * Offline demo data generator for the Postgres Query Optimizer room plugin.
 *
 * Run once:  node scripts/generate-demo-data.js > assets/demo/data.sql
 * Then:      gzip -k assets/demo/data.sql
 *
 * Generates ~50K users, ~500K orders, ~2M order_items with realistic
 * distributions (Zipfian, time-series, weighted enums).
 */

const NUM_USERS = 10_000;
const NUM_CATEGORIES = 20;
const NUM_PRODUCTS = 1_000;
const NUM_ORDERS = 100_000;
const AVG_ITEMS_PER_ORDER = 4;

const ORDER_STATUSES = ['completed', 'completed', 'completed', 'completed',
  'pending', 'pending', 'shipped', 'cancelled'];

const COUNTRY_CODES = ['US', 'US', 'US', 'GB', 'GB', 'DE', 'FR', 'CA', 'AU', 'JP'];
const CATEGORY_NAMES = [
  'Electronics', 'Clothing', 'Books', 'Home & Garden', 'Sports',
  'Toys', 'Automotive', 'Health', 'Beauty', 'Food',
  'Music', 'Movies', 'Software', 'Office', 'Pet Supplies',
  'Jewelry', 'Baby', 'Industrial', 'Art', 'Travel',
];

function mulberry32(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rng = mulberry32(42);

function randomInt(min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function zipfianInt(max, s = 1.2) {
  const u = rng();
  const value = Math.floor(Math.pow(u, s) * max) + 1;
  return Math.min(value, max);
}

function randomDate(startYear, endYear) {
  const start = new Date(startYear, 0, 1).getTime();
  const end = new Date(endYear, 11, 31).getTime();
  const ts = start + rng() * (end - start);
  return new Date(ts).toISOString();
}

function recentDate(daysBack) {
  const now = Date.now();
  const ts = now - rng() * daysBack * 86400000;
  return new Date(ts).toISOString();
}

function escapeSql(str) {
  return str.replace(/'/g, "''");
}

function main() {
  const out = process.stdout;

  out.write('-- Auto-generated demo data for postgres-query-optimizer\n');
  out.write('-- Do not edit manually\n\n');
  out.write('BEGIN;\n\n');

  // Categories
  out.write('-- Categories\n');
  for (let i = 1; i <= NUM_CATEGORIES; i++) {
    const name = CATEGORY_NAMES[i - 1] || `Category ${i}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    out.write(`INSERT INTO categories (id, name, slug) VALUES (${i}, '${escapeSql(name)}', '${slug}');\n`);
  }
  out.write(`SELECT setval('categories_id_seq', ${NUM_CATEGORIES});\n\n`);

  // Products
  out.write('-- Products\n');
  for (let i = 1; i <= NUM_PRODUCTS; i++) {
    const catId = randomInt(1, NUM_CATEGORIES);
    const price = randomInt(299, 99999);
    const created = randomDate(2020, 2025);
    out.write(`INSERT INTO products (id, category_id, name, price_cents, created_at) VALUES (${i}, ${catId}, 'Product ${i}', ${price}, '${created}');\n`);
  }
  out.write(`SELECT setval('products_id_seq', ${NUM_PRODUCTS});\n\n`);

  // Users (batch insert for speed)
  out.write('-- Users\n');
  const USER_BATCH = 500;
  for (let batch = 0; batch < NUM_USERS; batch += USER_BATCH) {
    const rows = [];
    const end = Math.min(batch + USER_BATCH, NUM_USERS);
    for (let i = batch + 1; i <= end; i++) {
      const country = COUNTRY_CODES[randomInt(0, COUNTRY_CODES.length - 1)];
      const created = randomDate(2019, 2025);
      rows.push(`(${i}, 'user${i}@example.com', 'User ${i}', '${created}', '${country}')`);
    }
    out.write(`INSERT INTO users (id, email, name, created_at, country_code) VALUES\n${rows.join(',\n')};\n`);
  }
  out.write(`SELECT setval('users_id_seq', ${NUM_USERS});\n\n`);

  // Orders (batch insert)
  out.write('-- Orders\n');
  const ORDER_BATCH = 500;
  for (let batch = 0; batch < NUM_ORDERS; batch += ORDER_BATCH) {
    const rows = [];
    const end = Math.min(batch + ORDER_BATCH, NUM_ORDERS);
    for (let i = batch + 1; i <= end; i++) {
      const userId = zipfianInt(NUM_USERS);
      const status = ORDER_STATUSES[randomInt(0, ORDER_STATUSES.length - 1)];
      const created = recentDate(365);
      const total = randomInt(500, 500000);
      rows.push(`(${i}, ${userId}, '${status}', ${total}, '${created}')`);
    }
    out.write(`INSERT INTO orders (id, user_id, status, total_cents, created_at) VALUES\n${rows.join(',\n')};\n`);
  }
  out.write(`SELECT setval('orders_id_seq', ${NUM_ORDERS});\n\n`);

  // Order items (batch insert — ~2M rows)
  out.write('-- Order Items\n');
  let itemId = 1;
  const ITEM_BATCH = 1000;
  let itemBuffer = [];

  for (let orderId = 1; orderId <= NUM_ORDERS; orderId++) {
    const numItems = randomInt(1, AVG_ITEMS_PER_ORDER * 2 - 1);
    for (let j = 0; j < numItems; j++) {
      const productId = zipfianInt(NUM_PRODUCTS);
      const qty = randomInt(1, 5);
      const price = randomInt(299, 49999);
      itemBuffer.push(`(${itemId}, ${orderId}, ${productId}, ${qty}, ${price})`);
      itemId++;
      if (itemBuffer.length >= ITEM_BATCH) {
        out.write(`INSERT INTO order_items (id, order_id, product_id, quantity, price_cents) VALUES\n${itemBuffer.join(',\n')};\n`);
        itemBuffer = [];
      }
    }
  }
  if (itemBuffer.length > 0) {
    out.write(`INSERT INTO order_items (id, order_id, product_id, quantity, price_cents) VALUES\n${itemBuffer.join(',\n')};\n`);
  }
  out.write(`SELECT setval('order_items_id_seq', ${itemId - 1});\n\n`);

  out.write('COMMIT;\n');
  out.write(`-- Total: ${NUM_USERS} users, ${NUM_CATEGORIES} categories, ${NUM_PRODUCTS} products, ${NUM_ORDERS} orders, ${itemId - 1} order_items\n`);
}

main();
