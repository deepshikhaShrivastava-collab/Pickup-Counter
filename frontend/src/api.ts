export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string;
  pricePaise: number;
  stockOnHand: number;
  available: number;
}

export type OrderStatus = 'pending_payment' | 'paid' | 'needs_review' | 'expired' | 'picked_up';

export interface Order {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  expiresAt: string;
  expiresInSeconds: number | null;
  reviewReason: string | null;
  createdAt: string;
  paidAt: string | null;
  pickedUpAt: string | null;
  items: { productId: number; name: string; quantity: number; unitPricePaise: number; lineTotalPaise: number }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data?.error ?? 'http_error',
      data?.message ?? `Request failed (${res.status})`,
      data?.details,
    );
  }
  return data as T;
}

export const api = {
  listProducts: () => request<{ products: Product[] }>('GET', '/api/products').then((r) => r.products),
  createOrder: (items: { productId: number; quantity: number }[]) =>
    request<{ order: Order }>('POST', '/api/orders', { items }).then((r) => r.order),
  getOrder: (id: string) => request<{ order: Order }>('GET', `/api/orders/${id}`).then((r) => r.order),
  claimPickup: (id: string) =>
    request<{ order: Order }>('POST', `/api/orders/${id}/pickup-claim`).then((r) => r.order),
};
