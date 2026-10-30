import { Activity, Suspense, type ReactNode } from 'react';
import type { Page } from './WorkspaceSidebar';

export default function PageCache({ active, pages, children }: { active: Page; pages: readonly Page[]; children: (page: Page) => ReactNode }) {
  return <Suspense fallback={<div className="empty-state" role="status">正在打开页面…</div>}>
    {pages.map(page => <Activity key={page} mode={page === active ? 'visible' : 'hidden'}>{children(page)}</Activity>)}
  </Suspense>;
}
