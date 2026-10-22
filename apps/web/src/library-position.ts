import { useLayoutEffect, useRef, type MutableRefObject } from 'react';

export type LibraryPosition = {
  scroll: number;
  preview?: string;
  anchor?: { id: string; offset: number; next?: string; previous?: string };
};

export function useLibraryPosition(position: MutableRefObject<LibraryPosition>, scope: string, rowIds: string) {
  const previousScope = useRef(scope);
  useLayoutEffect(() => {
    const cards = () => Array.from(document.querySelectorAll<HTMLElement>('.library-page .media-card'));
    const id = (card: HTMLElement) => card.dataset.artifactId || card.dataset.jobId!;
    const remember = () => {
      const rows = cards();
      let index = rows.findIndex(card => card.getBoundingClientRect().bottom > 100);
      if (index < 0) index = rows.length - 1;
      const card = rows[index];
      position.current.scroll = window.scrollY;
      position.current.anchor = card && window.scrollY > 0 ? {
        id: id(card), offset: card.getBoundingClientRect().top,
        next: rows[index + 1] && id(rows[index + 1]), previous: rows[index - 1] && id(rows[index - 1]),
      } : undefined;
    };
    if (previousScope.current !== scope) {
      position.current.scroll = 0; position.current.anchor = undefined;
      previousScope.current = scope;
    }
    const saved = position.current.anchor;
    const rows = cards();
    const anchor = saved && [saved.id, saved.next, saved.previous].map(key => rows.find(card => id(card) === key)).find(Boolean);
    window.scrollTo(0, anchor && saved ? window.scrollY + anchor.getBoundingClientRect().top - saved.offset : saved ? 0 : position.current.scroll);
    remember();
    window.addEventListener('scroll', remember, { passive: true });
    return () => window.removeEventListener('scroll', remember);
  }, [scope, rowIds]);
}
