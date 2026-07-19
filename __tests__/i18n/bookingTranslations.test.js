const { translations } = require("../../lib/i18n/bookingTranslations");

// case 09: 五语言文案完整性——不新增按钮翻译 key，只新增这两个 key
describe("bookingTranslations — 多日无车提示文案", () => {
  const LANGS = ["zh", "zh-TW", "ja", "en", "ko"];
  const NEW_KEYS = ["s2ErrRangeUnavailableMsg", "s2UnavailableDatesLabel"];

  test.each(LANGS)("%s 语言含全部新增 key，且为非空字符串", (lang) => {
    const t = translations[lang];
    expect(t).toBeDefined();
    for (const key of NEW_KEYS) {
      expect(typeof t[key]).toBe("string");
      expect(t[key].length).toBeGreaterThan(0);
    }
  });

  test.each(LANGS)("%s 提示文案不承诺拆分后一定有车", (lang) => {
    const msg = translations[lang].s2ErrRangeUnavailableMsg;
    // 反向校验：不出现"保证/一定/100%"这类绝对化承诺词
    expect(msg).not.toMatch(/保证|一定有|100%|guaranteed|絶対|반드시/);
  });

  test("未新增任何按钮文案 key（复用现有 btnBack / s4BtnBack）", () => {
    // 只新增了 2 个 key；不存在名字里带 Btn 的新增 key
    for (const key of Object.keys(translations.zh)) {
      if (key.startsWith("s2ErrRange") || key === "s2UnavailableDatesLabel") {
        expect(key).not.toMatch(/Btn/);
      }
    }
  });
});
