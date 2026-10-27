'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'paperloom.editor.panelLayout';

export function usePanelLayout(isMobile: boolean) {
  const [desktopPanelOpen, setDesktopPanelOpen] = useState(true);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [isThumbnailsOpen, setIsThumbnailsOpen] = useState(true);
  const [desktopFocusMode, setIsFocusMode] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Keep the mobile options panel closed when entering the mobile layout.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isMobile) setMobilePanelOpen(false);
  }, [isMobile]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const saved: unknown = raw ? JSON.parse(raw) : null;
      if (typeof saved === 'object' && saved !== null) {
        const { panel, thumbnails, focus } = saved as Record<string, unknown>;
        // Restore browser-only storage after hydration, keeping the initial SSR markup stable.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (typeof panel === 'boolean') setDesktopPanelOpen(panel);
        if (typeof thumbnails === 'boolean') setIsThumbnailsOpen(thumbnails);
        if (typeof focus === 'boolean') setIsFocusMode(focus);
      }
    } catch {
      // Storage may be unavailable or contain invalid data.
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        panel: desktopPanelOpen, thumbnails: isThumbnailsOpen, focus: desktopFocusMode,
      }));
    } catch {
      // The layout remains usable without storage.
    }
  }, [loaded, desktopPanelOpen, isThumbnailsOpen, desktopFocusMode]);

  return {
    isPanelOpen: isMobile ? mobilePanelOpen : desktopPanelOpen,
    setIsPanelOpen: isMobile ? setMobilePanelOpen : setDesktopPanelOpen,
    isThumbnailsOpen,
    setIsThumbnailsOpen,
    isFocusMode: !isMobile && desktopFocusMode,
    setIsFocusMode,
  };
}
