# QA Workbench

QA Workbench یک میزکار محلی برای مهندسی تست است. نیازمندی را از Jira یا فایل صفحه‌گسترده دریافت می‌کند، با هوش مصنوعی تحلیل و Test Case تولید می‌کند، اجرای تست و Bug را ثبت می‌کند و Scenarioهای API و Database را روی محیط تست اجرا می‌کند.

همه‌چیز روی ماشین خودتان باقی می‌ماند. Jira و مدل زبانی اختیاری هستند و بدون آن‌ها نیز سیستم با داده نمایشی و تحلیل آفلاین قابل استفاده است.

رابط کاربری تیره، فشرده و دوزبانه است. فارسی به‌صورت RTL و انگلیسی به‌صورت LTR نمایش داده می‌شود. اعداد و تاریخ نیز در حالت فارسی با ارقام و تقویم فارسی نمایش داده می‌شوند.

## قابلیت‌ها

### ورود نیازمندی

Issue را می‌توان مستقیماً از Jira دریافت کرد یا از فایل Excel و CSV وارد کرد.

یک Issue نمایشی نیز وجود دارد تا بدون اتصال به Jira بتوان کل Flow سیستم را مشاهده و تست کرد.

توکن Jira به‌صورت رمزنگاری‌شده ذخیره می‌شود و پس از ذخیره مجدداً به Client برگردانده نمی‌شود.

### تحلیل و طراحی تست

برای هر Requirement خروجی‌های زیر قابل تولید هستند:

- Requirement Analysis
- Test Strategy
- Test Cases
- Edge Cases
- Risks
- Automation Candidates

اگر Ollama در دسترس باشد، سیستم از مدل زبانی استفاده می‌کند. در غیر این صورت تحلیل Rule-Based و Offline تولید خواهد شد.

خروجی‌ها Structured هستند و اگر کاربر آن‌ها را به‌صورت دستی ویرایش کرده باشد، Generate مجدد نباید تغییرات دستی را بدون اجازه بازنویسی کند.

### مدیریت اجرای تست

Test Caseها را می‌توان در Suiteهای مختلف مانند Smoke، Regression یا Suiteهای سفارشی قرار داد.

نتیجه اجرای Test Case ثبت می‌شود و از اجرای Failed می‌توان Bug ایجاد کرد.

Dashboard اطلاعاتی مانند موارد زیر را نمایش می‌دهد:

- Pass Rate
- Test Coverage
- Status Distribution
- Execution History

### سناریوهای خودکار

Scenario مجموعه‌ای از Stepهای قابل اجرا است.

Stepها می‌توانند شامل موارد زیر باشند:

- HTTP Request
- Assertion
- Variable Extraction
- Set Variable
- Delay
- Condition
- Database Operation

اجرای Scenario به‌صورت Live انجام می‌شود.

امکان Cancel کردن Execution، توقف هنگام Failure یا Skip کردن Step ناموفق وجود دارد.

Variableها در Scope همان Scenario Execution باقی می‌مانند و مقادیر Sensitive در Logها Mask می‌شوند.

HTTP Requestها دارای محدودیت‌هایی مانند Timeout، Response Size Limit و محافظت در برابر آدرس‌های خطرناک هستند.

### Environment و Database Connector

هر Environment می‌تواند شامل Variableهای معمولی و Secret باشد.

Database Connector از موارد زیر پشتیبانی می‌کند:

- PostgreSQL
- MySQL
- SQL Server
- MongoDB
- Redis
- Elasticsearch

اطلاعات حساس Connection به‌صورت رمزنگاری‌شده ذخیره می‌شوند.

فقط Connectorهای Active داخل Scenario قابل اجرا هستند.

Database Query به یک Statement محدود است و عملیات مخرب مانند حذف Table رد می‌شوند.

---

# وابستگی‌ها

برای اجرای پروژه موارد زیر موردنیاز هستند:

- Node.js نسخه 20 یا جدیدتر
- npm
- PostgreSQL داخلی پروژه یا Docker

Redis اختیاری است. بدون Redis نیز API اجرا می‌شود و فقط وضعیت Redis در Health Check به‌صورت Disconnected نمایش داده می‌شود.

Ollama نیز اختیاری است.

آدرس پیش‌فرض Ollama:

```text
http://localhost:11434
```

مدل پیش‌فرض:

```text
llama3.2
```

Jira نیز اختیاری است و تنظیمات اتصال آن از داخل برنامه وارد می‌شود.

## Technology Stack

- Next.js
- React
- NestJS
- Prisma
- PostgreSQL
- Tailwind CSS
- shadcn/ui
- Apache ECharts
- Zod

---

# اجرا بدون Docker

ابتدا وارد Root اصلی پروژه شوید.

باید در مسیری باشید که فایل `package.json` در کنار پوشه‌های `apps` و `packages` قرار دارد.

اگر پروژه از فایل ZIP استخراج شده است، ممکن است یک Directory اضافه ایجاد شده باشد و لازم باشد یک Level داخل‌تر بروید.

## 1. نصب Dependencyها

```bash
npm install
```

## 2. Generate کردن Prisma Client

Prisma Schema این پروژه در مسیر زیر قرار دارد:

```text
apps/api/prisma/schema.prisma
```

Prisma Client را Generate کنید:

```bash
npx prisma generate --schema=apps/api/prisma/schema.prisma
```

در صورت موفقیت باید پیام مربوط به Generated شدن Prisma Client نمایش داده شود.

## 3. بررسی Build

```bash
npm run build
```

این مرحله خطاهای TypeScript، Prisma و سایر مشکلات Build را قبل از اجرای محیط مشخص می‌کند.

اگر Build بدون خطا انجام شد، مراحل بعدی را ادامه دهید.

## 4. اجرای Database

در Terminal اول و از Root پروژه اجرا کنید:

```bash
npm run demo:db
```

این دستور PostgreSQL داخلی پروژه را روی Port `5433` اجرا می‌کند، Tableهای موردنیاز را می‌سازد و فایل `.env` را آماده می‌کند.

این Terminal باید هنگام استفاده از QA Workbench باز بماند.

## 5. اجرای API

در Terminal دوم:

```bash
npm run dev:api
```

API به‌صورت پیش‌فرض روی Port `3001` اجرا می‌شود.

Health Check:

```text
http://localhost:3001/api/health
```

## 6. اجرای Web

در Terminal سوم:

```bash
npm run dev:web
```

رابط کاربری:

```text
http://localhost:3000
```

## 7. ایجاد Demo Data

بعد از بالا آمدن API:

```bash
npm run demo:seed
```

بعد از این مرحله می‌توانید Demo Flow سیستم را بدون Jira، Redis یا Ollama اجرا کنید.

---

# اجرای سریع بدون Docker

### Terminal اصلی

```bash
npm install
npx prisma generate --schema=apps/api/prisma/schema.prisma
npm run build
```

### Terminal 1

```bash
npm run demo:db
```

### Terminal 2

```bash
npm run dev:api
```

### Terminal 3

```bash
npm run dev:web
```

### بعد از بالا آمدن API

```bash
npm run demo:seed
```

---

# اگر Build قبل از Database اجرا نشد

اگر `npm run build` به Environment Variable یا Database نیاز داشت، ابتدا Database را اجرا کنید.

### Terminal 1

```bash
npm install
npm run demo:db
```

این Terminal را باز نگه دارید.

سپس در Terminal دیگری:

```bash
npx prisma generate --schema=apps/api/prisma/schema.prisma
npm run build
```

بعد:

```bash
npm run dev:api
```

و در Terminal دیگری:

```bash
npm run dev:web
```

بعد از بالا آمدن API:

```bash
npm run demo:seed
```

---

# اجرا با Docker

Environment را آماده کنید:

```bash
cp .env.example .env
cp .env apps/api/.env
```

Dependencyها را نصب کنید:

```bash
npm install
```

سرویس‌های Docker را اجرا کنید:

```bash
npm run docker:up
```

Prisma Client را Generate کنید:

```bash
npx prisma generate --schema=apps/api/prisma/schema.prisma
```

Migrationها را اجرا کنید:

```bash
npm run db:migrate
```

API را اجرا کنید:

```bash
npm run dev:api
```

و در Terminal دیگری:

```bash
npm run dev:web
```

در حالت Docker:

- PostgreSQL: Port `5432`
- Redis: Port `6379`
- Web: Port `3000`
- API: Port `3001`

---

# رفع خطای Prisma Schema

اگر دستور:

```bash
npx prisma generate
```

با خطای:

```text
Could not find Prisma Schema that is required for this command
```

مواجه شد، علت این است که Prisma Schema پروژه در مسیر Default قرار ندارد.

Schema اصلی پروژه:

```text
apps/api/prisma/schema.prisma
```

بنابراین دستور صحیح این است:

```bash
npx prisma generate --schema=apps/api/prisma/schema.prisma
```

از Schema موجود در مسیر زیر برای Generate کردن Client استفاده نکنید:

```text
node_modules/.prisma/client/schema.prisma
```

---

# رفع خطاهای Build و Prisma Type

اگر هنگام اجرای:

```bash
npm run build
```

خطاهای TypeScript مانند `TS7006` در بخش‌هایی که اطلاعات Jira را از Prisma دریافت می‌کنند مشاهده شد، ابتدا Prisma Client را دوباره Generate کنید:

```bash
npx prisma generate --schema=apps/api/prisma/schema.prisma
```

سپس:

```bash
npm run build
```

تابع‌هایی مانند `loadIssue()` ممکن است به Typeهای Generated توسط Prisma وابسته باشند.

برای رفع سریع TypeScript Error نباید پارامترهای این بخش‌ها بدون بررسی با `any` Type شوند.

اگر بعد از Generate کردن Prisma Client همچنان خطای Type مربوط به `loadIssue()` باقی ماند، Return Type تابع باید به‌صورت Explicit با Typeهای Generated خود Prisma تعریف شود.

بسته به Query موجود می‌توان از Typeهایی مانند:

```typescript
Prisma.JiraIssueGetPayload
```

استفاده کرد تا Type خروجی مستقیماً با Prisma Schema و Query واقعی هماهنگ باشد.

---

# مشکلات Port

اگر Port `3001` اشغال باشد، ابتدا Process مربوط به آن را پیدا کنید:

```bash
lsof -i :3001
```

بعد از متوقف کردن Process قبلی، API را مجدداً اجرا کنید:

```bash
npm run dev:api
```

اگر Port `5433` اشغال باشد:

```bash
lsof -i :5433
```

بعد از متوقف کردن Instance قبلی:

```bash
npm run demo:db
```

---

# مسیر Demo

برای مشاهده Flow کامل سیستم بدون نیاز به سرویس‌های خارجی:

1. وارد صفحه Jira شوید.
2. Demo Issue را Load کنید.
3. وارد Workspace شوید.
4. Requirement Analysis را Generate کنید.
5. Test Strategy را Generate کنید.
6. Test Caseها را Generate کنید.
7. Edge Caseها و Riskها را بررسی کنید.
8. Test Case موردنظر را اجرا کنید.
9. در صورت Failure از Execution یک Bug ایجاد کنید.
10. یک Test Suite ایجاد کنید.
11. وارد بخش Scenario شوید.
12. یک HTTP یا Database Scenario تعریف کنید.
13. Scenario را اجرا کرده و نتیجه Stepها را مشاهده کنید.

برای اجرای این Demo Flow نیازی به Jira، Redis یا Ollama نیست.