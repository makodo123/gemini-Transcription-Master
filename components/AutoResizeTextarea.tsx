import React, { useEffect, useLayoutEffect, useRef } from 'react';

// 每個文字框上次調整高度時的寬度；寬度變了換行位置就會變，需要重算
const fittedWidth = new WeakMap<HTMLTextAreaElement, number>();
const mounted = new Set<HTMLTextAreaElement>();

/** 依內容調整高度：scrollHeight 含內距、不含邊框，依 box-sizing 換算成 height */
const fitHeight = (el: HTMLTextAreaElement) => {
  el.style.height = 'auto';
  const style = getComputedStyle(el);
  const height = style.boxSizing === 'border-box'
    ? el.scrollHeight + el.offsetHeight - el.clientHeight
    : el.scrollHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  el.style.height = `${height}px`;
  fittedWidth.set(el, el.clientWidth);
};

// 網頁字型載入完成後字寬改變，換行位置跟著變
document.fonts?.addEventListener?.('loadingdone', () => mounted.forEach(fitHeight));

/**
 * 高度隨內容自動調整的文字框，長句子不會被切掉、也不用在框內捲動。
 */
const AutoResizeTextarea: React.FC<React.TextareaHTMLAttributes<HTMLTextAreaElement>> = (props) => {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current);
  }, [props.value]);

  // 寬度和上次調整時不同就重算（視窗縮放、樣式晚一步套用）；只比寬度，避免自己改高度又觸發
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    mounted.add(el);
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== fittedWidth.get(el)) fitHeight(el);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      mounted.delete(el);
    };
  }, []);

  return <textarea ref={ref} rows={1} {...props} />;
};

export default AutoResizeTextarea;
