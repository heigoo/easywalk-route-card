import { useEffect, useState } from 'react';

/** 按视口宽度响应（第 9.2 节决策表），不按设备型号判断 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** 双列布局断点：≥1024px（电脑/平板宽横屏） */
export function useIsWide(): boolean {
  return useMediaQuery('(min-width: 1024px)');
}
