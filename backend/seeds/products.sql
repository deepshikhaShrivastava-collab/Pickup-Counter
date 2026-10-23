-- Idempotent: re-running never duplicates products or resets stock.
INSERT INTO products (sku, name, description, price_paise, stock_on_hand) VALUES
  ('CHAI-MASALA',  'Masala Chai',          'Cutting chai brewed with ginger and cardamom', 4000,  50),
  ('SAMOSA-2',     'Samosa (2 pcs)',       'Potato and pea samosas with mint chutney',     3000,  30),
  ('SANDWICH-VEG', 'Bombay Veg Sandwich',  'Grilled, with green chutney and cheese',       12000, 15),
  ('WRAP-PANEER',  'Paneer Tikka Wrap',    'Tandoori paneer, onions and mint mayo',        15000, 10),
  ('COFFEE-COLD',  'Cold Coffee',          'Blended with vanilla ice cream',               9000,  2)
ON CONFLICT (sku) DO NOTHING;
