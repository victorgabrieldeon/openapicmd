import { useState, useCallback } from 'react';

export function useScrollList(itemCount: number, visibleCount: number) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);

  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => {
      const next = Math.max(0, prev - 1);
      setScrollOffset((offset) => (next < offset ? next : offset));
      return next;
    });
  }, []);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => {
      const next = Math.min(itemCount - 1, prev + 1);
      setScrollOffset((offset) => {
        const maxOffset = Math.max(0, itemCount - visibleCount);
        const newOffset = next >= offset + visibleCount ? next - visibleCount + 1 : offset;
        return Math.min(newOffset, maxOffset);
      });
      return next;
    });
  }, [itemCount, visibleCount]);

  const setIndex = useCallback(
    (idx: number) => {
      const clamped = Math.max(0, Math.min(itemCount - 1, idx));
      setSelectedIndex(clamped);
      setScrollOffset((offset) => {
        if (clamped < offset) return clamped;
        if (clamped >= offset + visibleCount) return clamped - visibleCount + 1;
        return offset;
      });
    },
    [itemCount, visibleCount]
  );

  const visibleItems = <T>(items: T[]): T[] =>
    items.slice(scrollOffset, scrollOffset + visibleCount);

  return { selectedIndex, scrollOffset, moveUp, moveDown, setIndex, visibleItems };
}
