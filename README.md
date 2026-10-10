<div dir="rtl" align="right">

# QA Workbench

میزکار محلی مهندسی تست: از نیازمندی تا Test Case، اجرا، Bug و آماده‌سازی محیط تست، همه در یک جا و روی ماشین خودتان.

- **تحلیل نیازمندی با هوش مصنوعی** که شاهد می‌آورد و خروجی ساختگی نمی‌دهد
- **ضبط کار در مرورگر** و تکرار هوشمند آن، حتی وقتی صفحه بازطراحی شود
- **زنجیرهٔ cURL، UI و Database** با اتصال خودکار داده بین مراحل
- **خروجی کد Automation** برای Playwright، Selenium، Cypress و Robot Framework

---

## قابلیت‌ها

### تحلیل نیازمندی با هوش مصنوعی

Issue از Jira یا Excel/CSV وارد می‌شود (همراه PRD به‌صورت ‎.md، ‎.txt، ‎.pdf یا ‎.docx) و در یک Pipeline چندمرحله‌ای تحلیل می‌شود:

- قواعد کسب‌وکار، APIها، وضعیت‌ها و گذارها، فرمول‌ها و مدل داده
- معیارهای پذیرش (اگر تسک AC نداشته باشد، از متن و PRD پیشنهاد می‌شوند)
- شکاف‌ها و پرسش‌ها، Test Strategy، Test Cases، Edge Cases، Risks و پیشنهاد Automation

**ضد خروجی ساختگی:** هر قاعده و معیار باید جمله‌ای از خود تسک یا PRD را شاهد بیاورد، و یک **مدل دوم** خروجی را بازبینی و موارد بی‌پشتوانه یا تکراری را حذف می‌کند. پیشنهادهای تأییدنشده «نیازمند بازبینی» علامت می‌خورند.

**یاد می‌گیرد:** هر ویرایش، تأیید یا رد ثبت می‌شود، دفعهٔ بعد به‌عنوان نمونه به مدل داده می‌شود و به‌مرور به «رهنمود» تبدیل می‌شود که قابل ویرایش و خاموش کردن است. ویرایش‌های کاربر در اجراهای بعدی دست نمی‌خورند.

**چند سرویس، بدون وقفه:** هر مرحله سرویس خودش را دارد، با Failover خودکار هنگام خطا یا Rate Limit و اجرای موازی مراحل مستقل. از Ollama و LM Studio محلی تا سرویس‌های رایگان آنلاین (Pollinations بدون کلید؛ Hugging Face، GitHub Models، SambaNova، Mistral، Groq، Gemini، OpenRouter، Cerebras). اطلاعات محرمانهٔ متن پیش از ارسال پوشانده و کلیدها رمزنگاری‌شده ذخیره می‌شوند.

### مدیریت اجرای تست

Suiteها (Smoke، Regression، سفارشی)، ثبت نتیجه، ساخت Bug از اجرای Failed و Dashboard با Pass Rate، Coverage و Execution History.

### پیش‌شرط‌ها: آماده‌سازی محیط تست

هر پیش‌شرط زنجیره‌ای از Stepهاست (UI در مرورگر، HTTP، Assertion، Variable، Delay، Condition و Database) که سیستم را به وضعیت لازم برای تست می‌رساند.

#### مرحلهٔ UI: ضبط یک بار، اجرا همیشه

- **ضبط در Chrome واقعی:** کلیک، تایپ، انتخاب، تب جدید و بررسی متن؛ تایپ‌های پشت‌سرهم یک اقدام می‌شوند.
- **Locator مثل یک انسان:** عنصر با Role و نام، Label، Placeholder و متن شناخته می‌شود، نه ساختار HTML، به‌همراه اثرانگشت عنصر.
- **خودترمیم (Self-healing):** اگر صفحه بازطراحی شود، عنصر از راه دیگر یا با شباهت پیدا می‌شود و راه جدید برای اجرای بعد ذخیره می‌شود.
- **اجرای هدف‌محور، نه کلمه‌به‌کلمه:** Redirectها و آدرس‌های دارای کد تازه (سبد، فاکتور) دنبال می‌شوند، OTPی که خودش ثبت می‌شود درست مدیریت می‌شود، متن با عدد متغیر پیدا می‌شود و انتخاب گزینه (مثلاً روش پرداخت) پس از کلیک تأیید می‌شود.
- **شروع در حالت لاگین:** Cookie، Header و Token مراحل قبلی (مثلاً cURL لاگین) به مرورگر داده می‌شود و کلید Token خود اپلیکیشن یاد گرفته می‌شود.
- **ضبط دوبارهٔ بخشی:** فقط چند اقدام عوض‌شده را دوباره ضبط کنید؛ اقدام‌های قبلی (مثل لاگین) خودکار اجرا می‌شوند.
- **امن:** رمز و OTP رمزنگاری‌شده ذخیره می‌شوند. خطای صفحه (مثلاً «رمز اشتباه است») Step را با همان پیام ناموفق می‌کند.

#### خروجی کد Automation

هر پیش‌شرط، شامل مراحل UI، HTTP و Database، با یک کلیک به یک فایل تست قابل اجرا تبدیل می‌شود:

| Framework | زبان‌ها |
|---|---|
| Playwright | TypeScript، JavaScript، Python، Robot Framework (Browser library) |
| Selenium | Java، Python، JavaScript، TypeScript، Robot Framework (SeleniumLibrary) |
| Cypress | TypeScript، JavaScript |

کد تولیدشده پیش از نمایش اعتبارسنجی می‌شود: Framework و زبان درست، نبود API فریم‌ورک‌های دیگر، حضور URLها، مقدارها و متن‌های پیش‌شرط، شمارش اقدام‌های مرورگر، و حذف هر Secret از کد.

#### زنجیرهٔ API با اتصال خودکار داده

- **Import چند cURL** با صفحهٔ Review: هشدارها، دستورهای Malformed و ارتباط‌های شناسایی‌شده.
- **تشخیص خودکار Mapping:** سیستم پیدا می‌کند هر فیلد (Token، شناسه در Path، …) از پاسخ کدام Step قبلی می‌آید. فقط موارد مطمئن ذخیره می‌شوند، چون Mapping اشتباه از نداشتن Mapping بدتر است.
- **بدون Variable و JSONPath:** مقدار را در Response Explorer انتخاب کنید و «در درخواست بعدی استفاده» را بزنید. فقط محل مقدار ذخیره می‌شود و هر اجرا مقدار تازه را می‌خواند.
- **انتخاب آیتم با شرط:** از یک فهرست، آیتمی که با یک شرط جور است (مثلاً سفارشی که کدش در آدرس پایانی مرحلهٔ UI است) انتخاب می‌شود، نه جایگاه ثابت.
- **تشخیص خطا حتی با 2xx:** پاسخ‌هایی مثل `success: false` یا `errors` پر شکست حساب می‌شوند و خطا به فیلد و Mapping مقصر وصل می‌شود.
- **Retry امن:** حداکثر ۱۰ تلاش فقط با مقدارهای واقعی پاسخ‌های قبلی؛ POST فقط با Idempotency و DELETE هرگز. اگر مقدار یک Mapping در دسترس نباشد، Step **Blocked** می‌شود و درخواستی با مقدار قدیمی نمی‌رود.
- **حفاظت:** Mask شدن مقادیر حساس در UI و Log، Timeout، سقف حجم پاسخ و محافظت SSRF.

### Environment و Database

Environment با Variable و Secret، و Connector برای PostgreSQL، MySQL، SQL Server، MongoDB، Redis و Elasticsearch. اطلاعات اتصال رمزنگاری‌شده است و Queryهای مخرب رد می‌شوند.

---

## اجرا

پیش‌نیاز: Node.js 20+، npm. Redis و Jira اختیاری‌اند. برای مراحل UI، Chrome، Chromium یا Edge لازم است (یا مسیرش در `UI_BROWSER_PATH`).

<div dir="ltr" align="left">

```bash
npm install
npx prisma generate --schema=apps/api/prisma/schema.prisma

npm run demo:db     # terminal 1 — PostgreSQL on :5433, creates .env
npm run dev:api     # terminal 2 — http://localhost:3001/api/health
npm run dev:web     # terminal 3 — http://localhost:3000
npm run demo:seed   # demo issue, once the API is up
```

</div>

با Docker: `cp .env.example .env && cp .env apps/api/.env`، سپس `npm run docker:up` و `npm run db:migrate` و بعد `dev:api` و `dev:web`.

### هوش مصنوعی

ساده‌ترین شروع: در «تنظیمات ← AI provider»، Pollinations (بدون کلید) یا یک سرویس با کلید رایگان را اضافه کنید. برای اجرای کاملاً محلی و خصوصی:

<div dir="ltr" align="left">

```bash
curl -fsSL https://ollama.com/install.sh | sh
OLLAMA_KEEP_ALIVE=30m ollama serve
ollama pull qwen3:8b
```

</div>

سپس سرویس «Ollama — محلی» را با آدرس `http://localhost:11434` اضافه کنید. روی CPU، Timeout را دست‌کم `3600000` بگذارید.

---

## تست‌ها

<div dir="ltr" align="left">

```bash
npm run test
npm run typecheck
npm run lint
```

</div>

تست‌های تحلیل و پیش‌شرط‌ها با Mock API و مدل شبیه‌سازی‌شده اجرا می‌شوند. تست‌های مرحلهٔ UI با Chrome واقعی روی یک وب‌سایت آزمایشی محلی اجرا می‌شوند و در نبود مرورگر Skip می‌شوند.

## Stack

Next.js · React · NestJS · Prisma · PostgreSQL · Tailwind CSS · shadcn/ui · ECharts · Zod · Playwright

</div>
