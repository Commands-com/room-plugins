-- Demo slow query: monthly revenue by category for completed orders in the last 90 days
-- Genuinely slow without indexes on orders(user_id, created_at, status) or order_items(order_id)
SELECT
  c.name                                          AS category,
  DATE_TRUNC('month', o.created_at)               AS month,
  COUNT(DISTINCT o.id)                             AS order_count,
  SUM(oi.quantity)                                 AS items_sold,
  SUM(oi.price_cents * oi.quantity)                AS revenue_cents
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p     ON p.id = oi.product_id
JOIN categories c   ON c.id = p.category_id
WHERE o.status = 'completed'
  AND o.created_at >= NOW() - INTERVAL '90 days'
GROUP BY c.name, DATE_TRUNC('month', o.created_at)
ORDER BY revenue_cents DESC;
