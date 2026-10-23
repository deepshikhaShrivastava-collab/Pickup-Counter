import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type Product } from '../api';
import { formatPaise } from '../money';
import { navigate } from '../router';

type Cart = Record<number, number>;
const CART_KEY = 'pickup-counter.cart';
const PRODUCTS_REFRESH_MS = 5000;

function loadCart(): Cart {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) ?? '{}') as Cart;
  } catch {
    return {};
  }
}

function saveCart(cart: Cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    // storage unavailable: the cart just won't survive a reload
  }
}

export function ShopPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cart, setCart] = useState<Cart>(loadCart);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setProducts(await api.listProducts());
      setLoadError(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, PRODUCTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => saveCart(cart), [cart]);

  const byId = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const lines = Object.entries(cart)
    .map(([id, quantity]) => ({ product: byId.get(Number(id)), quantity }))
    .filter((l): l is { product: Product; quantity: number } => !!l.product && l.quantity > 0);
  const totalPaise = lines.reduce((sum, l) => sum + l.product.pricePaise * l.quantity, 0);

  function setQuantity(productId: number, quantity: number) {
    setCheckoutError(null);
    setCart((c) => {
      const next = { ...c };
      if (quantity <= 0) delete next[productId];
      else next[productId] = quantity;
      return next;
    });
  }

  async function checkout() {
    setSubmitting(true);
    setCheckoutError(null);
    try {
      const order = await api.createOrder(lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })));
      setCart({});
      navigate(`#/orders/${order.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'insufficient_stock') {
        const name = byId.get(Number(err.details?.productId))?.name ?? 'An item';
        setCheckoutError(`${name}: only ${err.details?.available ?? 0} left. Adjust your cart and try again.`);
        refresh();
      } else {
        setCheckoutError((err as Error).message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="shop">
      <section className="catalog" aria-label="Products">
        <h1>Menu</h1>
        {loadError && <p className="banner error">Could not load products: {loadError}</p>}
        {!products && !loadError && <p className="muted">Loading…</p>}
        <div className="grid">
          {products?.map((p) => {
            const inCart = cart[p.id] ?? 0;
            const soldOut = p.available <= 0;
            return (
              <article key={p.id} className="card">
                <h2>{p.name}</h2>
                <p className="muted">{p.description}</p>
                <div className="card-foot">
                  <span className="price">{formatPaise(p.pricePaise)}</span>
                  <span className={soldOut ? 'stock out' : p.available <= 3 ? 'stock low' : 'stock'}>
                    {soldOut ? 'Sold out' : `${p.available} available`}
                  </span>
                </div>
                <button
                  disabled={soldOut || inCart >= p.available}
                  onClick={() => setQuantity(p.id, inCart + 1)}
                >
                  {inCart ? `Add another (${inCart} in cart)` : 'Add to cart'}
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <aside className="cart" aria-label="Cart">
        <h2>Your order</h2>
        {lines.length === 0 ? (
          <p className="muted">Your cart is empty.</p>
        ) : (
          <>
            <ul className="lines">
              {lines.map(({ product, quantity }) => (
                <li key={product.id}>
                  <span className="line-name">{product.name}</span>
                  <span className="qty">
                    <button aria-label={`Remove one ${product.name}`} onClick={() => setQuantity(product.id, quantity - 1)}>
                      −
                    </button>
                    <span>{quantity}</span>
                    <button
                      aria-label={`Add one ${product.name}`}
                      disabled={quantity >= product.available}
                      onClick={() => setQuantity(product.id, quantity + 1)}
                    >
                      +
                    </button>
                  </span>
                  <span className="line-total">{formatPaise(product.pricePaise * quantity)}</span>
                </li>
              ))}
            </ul>
            <div className="total">
              <span>Total</span>
              <span>{formatPaise(totalPaise)}</span>
            </div>
          </>
        )}
        {checkoutError && <p className="banner error">{checkoutError}</p>}
        <button className="primary" disabled={lines.length === 0 || submitting} onClick={checkout}>
          {submitting ? 'Reserving…' : 'Reserve and pay'}
        </button>
        <p className="muted small">Items are held for 2 minutes while you pay.</p>
      </aside>
    </div>
  );
}
