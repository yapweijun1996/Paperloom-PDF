'use client';

import { useEffect } from 'react';
import { BRAND_BASE_PATH } from '@/lib/brand';

/** Register only the static app shell; user PDFs remain in their existing storage. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator) || !window.isSecureContext) return;
    const register = () => {
      void navigator.serviceWorker.register(`${BRAND_BASE_PATH}/sw.js`, { scope: `${BRAND_BASE_PATH}/` })
        .catch(error => console.warn('Offline support is unavailable:', error));
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);
  return null;
}
