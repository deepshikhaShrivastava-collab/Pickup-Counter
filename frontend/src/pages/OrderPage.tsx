import { useEffect, useRef, useState } from 'react';
import { api, type Order, type OrderStatus } from '../api';
import { formatCountdown, remainingSeconds } from '../countdown';
import { formatPaise } from '../money';

const POLL_MS = 2000;
// An expired order can still move to needs_review if a late payment arrives, so keep
// checking it, just less often. Only picked_up is truly final.
const EXPIRED_POLL_MS = 10_000;
const FINAL: OrderStatus[] = ['picked_up'];

const STATUS_TEXT: Record<OrderStatus, { title: string; body: string; tone: string }> = {
  pending_payment: { title: 'Waiting for payment', body: 'Your items are reserved until the timer runs out.', tone: 'info' },
  paid: { title: 'Paid. Ready for pickup', body: 'Show this order at the counter to collect it.', tone: 'ok' },
  needs_review: { title: 'Payment under review', body: 'We received a payment that needs a quick check by staff. Please ask at the counter.', tone: 'warn' },
  expired: { title: 'Reservation expired', body: 'The 2-minute hold ended before payment arrived, so the items were released.', tone: 'error' },
  picked_up: { title: 'Collected', body: 'Enjoy! This order has been handed over.', tone: 'ok' },
};

const REVIEW_TEXT: Record<string, string> = {
  amount_mismatch: 'The amount paid did not match the order total.',
  late_payment_stock_reserved: 'Payment arrived after the hold expired. Your items have been set aside while staff confirm.',
  late_payment_refund_required: 'Payment arrived after the hold expired and the items are no longer available. A refund will be issued.',
};

export function OrderPage({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const syncedAt = useRef(Date.now());
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Poll the server until the order reaches a final state.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      let delay = POLL_MS;
      try {
        const next = await api.getOrder(orderId);
        if (cancelled) return;
        syncedAt.current = Date.now();
        setOrder(next);
        setError(null);
        if (FINAL.includes(next.status)) return;
        if (next.status === 'expired') delay = EXPIRED_POLL_MS;
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
      }
      timer = setTimeout(poll, delay);
    }
    poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orderId]);

  // Local tick between polls for a smooth countdown; the value itself comes from the server.
  useEffect(() => {
    if (order?.status !== 'pending_payment') return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [order?.status]);

  if (!order) {
    return <section className="order">{error ? <p className="banner error">{error}</p> : <p className="muted">Loading order…</p>}</section>;
  }

  const status = STATUS_TEXT[order.status];
  const secondsLeft =
    order.expiresInSeconds === null ? null : remainingSeconds(order.expiresInSeconds, syncedAt.current, now);
  const webhookCommand = `cd backend; npm run webhook -- --order ${order.id}`;

  async function claim() {
    setClaiming(true);
    setClaimError(null);
    try {
      setOrder(await api.claimPickup(order!.id));
    } catch (err) {
      setClaimError((err as Error).message);
    } finally {
      setClaiming(false);
    }
  }

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(webhookCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: the command is still visible to select manually
    }
  }

  return (
    <section className="order">
      <a href="#/" className="back">
        ← Back to menu
      </a>
      <div className={`status ${status.tone}`} role="status" aria-live="polite">
        <div>
          <h1>{status.title}</h1>
          <p>{status.body}</p>
          {order.reviewReason && <p className="small">{REVIEW_TEXT[order.reviewReason] ?? order.reviewReason}</p>}
        </div>
        {secondsLeft !== null && (
          <div className={secondsLeft <= 20 ? 'countdown urgent' : 'countdown'} aria-label="Time left to pay">
            {formatCountdown(secondsLeft)}
          </div>
        )}
      </div>

      {error && <p className="banner warn">Connection problem, retrying: {error}</p>}

      <div className="order-body">
        <div className="panel">
          <h2>Order summary</h2>
          <ul className="lines">
            {order.items.map((i) => (
              <li key={i.productId}>
                <span className="line-name">{i.name}</span>
                <span className="qty">× {i.quantity}</span>
                <span className="line-total">{formatPaise(i.lineTotalPaise)}</span>
              </li>
            ))}
          </ul>
          <div className="total">
            <span>Total</span>
            <span>{formatPaise(order.totalPaise)}</span>
          </div>
          <p className="muted small mono">Order {order.id}</p>
        </div>

        {order.status === 'pending_payment' && (
          <div className="panel">
            <h2>Pay {formatPaise(order.totalPaise)}</h2>
            <p className="muted">
              This demo has no real payment provider. Simulate the provider's signed webhook from a terminal:
            </p>
            <pre className="command">{webhookCommand}</pre>
            <button onClick={copyCommand}>{copied ? 'Copied' : 'Copy command'}</button>
            <p className="muted small">This page updates on its own once the payment arrives.</p>
          </div>
        )}

        {order.status === 'paid' && (
          <div className="panel">
            <h2>Counter</h2>
            <p className="muted">Staff: hand over the items, then confirm. Only one confirmation can succeed.</p>
            {claimError && <p className="banner error">{claimError}</p>}
            <button className="primary" disabled={claiming} onClick={claim}>
              {claiming ? 'Confirming…' : 'Confirm pickup'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
