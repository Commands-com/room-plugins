import { describe, it, expect } from 'vitest';
import { quoteIdent } from '../lib/utils.js';
import { extractQueryTableRefs } from '../../sql-optimizer-core/index.js';

describe('quoteIdent', () => {
  it('quotes a simple name', () => {
    expect(quoteIdent('orders')).toBe('"orders"');
  });

  it('quotes a schema-qualified name', () => {
    expect(quoteIdent('public.orders')).toBe('"public"."orders"');
  });

  it('doubles embedded double-quotes', () => {
    expect(quoteIdent('my"table')).toBe('"my""table"');
  });

  it('handles mixed-case names', () => {
    expect(quoteIdent('OrderItems')).toBe('"OrderItems"');
  });

  it('handles reserved words', () => {
    expect(quoteIdent('select')).toBe('"select"');
    expect(quoteIdent('user')).toBe('"user"');
  });

  it('handles schema-qualified with special chars', () => {
    expect(quoteIdent('my schema.My Table')).toBe('"my schema"."My Table"');
  });

  it('handles empty/null input', () => {
    expect(quoteIdent('')).toBe('""');
    expect(quoteIdent(null)).toBe('""');
    expect(quoteIdent(undefined)).toBe('""');
  });
});

describe('extractQueryTableRefs', () => {
  it('extracts simple FROM references', () => {
    const refs = extractQueryTableRefs('SELECT * FROM orders WHERE id = 1');
    expect(refs).toContain('orders');
  });

  it('extracts JOIN references', () => {
    const refs = extractQueryTableRefs(
      'SELECT * FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id',
    );
    expect(refs).toContain('orders');
    expect(refs).toContain('order_items');
    expect(refs).toContain('products');
  });

  it('extracts schema-qualified references', () => {
    const refs = extractQueryTableRefs('SELECT * FROM public.orders JOIN sales.items ON true');
    expect(refs).toContain('public.orders');
    expect(refs).toContain('orders');
    expect(refs).toContain('sales.items');
    expect(refs).toContain('items');
  });

  it('skips keywords and subquery aliases', () => {
    const refs = extractQueryTableRefs('SELECT * FROM lateral unnest(arr)');
    expect(refs).not.toContain('lateral');
    expect(refs).not.toContain('unnest');
  });

  it('returns empty for null/empty', () => {
    expect(extractQueryTableRefs(null)).toEqual([]);
    expect(extractQueryTableRefs('')).toEqual([]);
  });
});
