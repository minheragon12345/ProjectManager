import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from './en';
import vi from './vi';

const DICTS = { en, vi };
const LOCALES = { en: 'en-US', vi: 'vi-VN' };
const STORAGE_KEY = 'pm-lang';

const Ctx = createContext({
  lang: 'en',
  locale: 'en-US',
  setLang: () => {},
  t: (k) => k,
});

function readInitialLang() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && DICTS[stored]) return stored;
    // Fall back to browser locale if it's one we support.
    const nav = (navigator?.language || '').toLowerCase();
    if (nav.startsWith('vi')) return 'vi';
  } catch {
    // ignore
  }
  return 'en';
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(readInitialLang);

  const setLang = useCallback((next) => {
    const chosen = DICTS[next] ? next : 'en';
    setLangState(chosen);
    try {
      localStorage.setItem(STORAGE_KEY, chosen);
    } catch {
      // ignore
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = chosen;
    }
  }, []);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang;
    }
  }, [lang]);

  const t = useCallback(
    (key, vars) => {
      const primary = DICTS[lang] || DICTS.en;
      const fallback = DICTS.en;
      let template = primary[key];
      if (template === undefined) template = fallback[key];
      if (template === undefined) return key;
      if (!vars) return template;
      let out = template;
      for (const [k, v] of Object.entries(vars)) {
        out = out.split('{' + k + '}').join(String(v));
      }
      return out;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, locale: LOCALES[lang] || 'en-US', setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}

export const SUPPORTED_LANGS = Object.keys(DICTS);
