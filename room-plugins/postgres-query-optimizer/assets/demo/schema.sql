-- Demo e-commerce schema for Postgres Query Optimizer
-- Primary key indexes only — no additional indexes

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  country_code  CHAR(2) NOT NULL DEFAULT 'US'
);

CREATE TABLE categories (
  id    SERIAL PRIMARY KEY,
  name  VARCHAR(120) NOT NULL,
  slug  VARCHAR(120) NOT NULL
);

CREATE TABLE products (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  name          VARCHAR(255) NOT NULL,
  price_cents   INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE orders (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  status      VARCHAR(20) NOT NULL DEFAULT 'pending',
  total_cents INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER NOT NULL DEFAULT 1,
  price_cents INTEGER NOT NULL
);
