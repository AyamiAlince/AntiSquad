(function () {
  'use strict';

  AS.LOCALES = AS.LOCALES || {};
  AS.SUPPORTED_LANGS = ['en', 'ru'];
  AS.loadAllTranslations = function () {
    const promises = AS.SUPPORTED_LANGS.map(function (lang) {
      return new Promise(function (resolve) {
        if (AS.LOCALES[lang]) {
          return resolve();
        }

        const script = document.createElement('script');
        script.src = `../common/locales/${lang}.js`;
        script.onload = resolve;
        script.onerror = resolve; 
        
        document.head.appendChild(script);
      });
    });

    return Promise.all(promises);
  };

  AS.translate = function (key, lang, ...args) {
    const currentLang = lang || 'en';
    const dict = (AS.LOCALES && AS.LOCALES[currentLang]) || AS.LOCALES['en'];
    const val = dict[key] || (AS.LOCALES['en'] && AS.LOCALES['en'][key]) || key;
    return typeof val === 'function' ? val(...args) : val;
  };
})();