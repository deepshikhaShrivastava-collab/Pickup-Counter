import { useEffect, useState } from 'react';
import { OrderPage } from './pages/OrderPage';
import { ShopPage } from './pages/ShopPage';

function currentRoute(): { page: 'shop' } | { page: 'order'; id: string } {
  const match = window.location.hash.match(/^#\/orders\/([0-9a-f-]{36})$/i);
  return match ? { page: 'order', id: match[1]! } : { page: 'shop' };
}

export function App() {
  const [route, setRoute] = useState(currentRoute);

  useEffect(() => {
    const onChange = () => setRoute(currentRoute());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          Pickup Counter
        </a>
        <span className="tagline">Order ahead, pay, collect at the counter</span>
      </header>
      <main>{route.page === 'order' ? <OrderPage key={route.id} orderId={route.id} /> : <ShopPage />}</main>
    </div>
  );
}
