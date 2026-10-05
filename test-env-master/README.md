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

تحلیل Test Workspace با مدل زبانی انجام می‌شود و برای هر Requirement این خروجی‌ها را می‌سازد:

- خلاصه و فهم ساختاریافتهٔ نیازمندی: قواعد کسب‌وکار (R1، R2، …)، APIها، وضعیت‌ها و گذارها، پیکربندی و فرمول‌ها، جریان‌ها و مدل داده
- معیارهای پذیرش (اگر تسک AC نداشته باشد، از روی توضیحات و PRD پیشنهاد می‌شوند)
- شکاف‌ها، ابهام‌ها و پرسش‌ها از محصول، توسعه‌دهنده و کسب‌وکار
- Test Strategy، Test Cases، Edge Cases، Risks و پیشنهاد Automation

#### تحلیل چندمرحله‌ای

تحلیل در پس‌زمینه و در چند مرحله اجرا می‌شود و پیشرفت هر مرحله و مدلی که روی آن کار می‌کند در صفحه دیده می‌شود:

1. خلاصه‌سازی اسناد طولانی (فقط اگر در Context مدل جا نشوند)
2. فهم نیازمندی
3. معیارهای پذیرش
4. شکاف‌ها، پرسش‌ها، ریسک‌ها و استراتژی، و هم‌زمان با آن طراحی Test Case، حالات مرزی و ترجمه
5. بازبینی مستقل توسط یک مدل دیگر
6. پیشنهاد Automation

برای جلوگیری از خروجی ساختگی:

- هر قاعده و هر معیار پیشنهادی باید جمله‌ای از متن خود تسک یا PRD را به‌عنوان شاهد بیاورد؛ شاهدی که در متن پیدا نشود اطمینان را «نامطمئن» می‌کند.
- مرحلهٔ بازبینی موارد بی‌پشتوانه، تکراری یا مبهم را حذف یا اصلاح می‌کند.
- معیارهای پیشنهادی هوش مصنوعی تا وقتی تأیید نشوند «پیشنهاد» هستند و Test Caseهای آن‌ها «نیازمند بازبینی» علامت می‌خورند.

#### زبان تحلیل

با دو دکمهٔ «تحلیل فارسی» و «تحلیل انگلیسی»، همهٔ خروجی‌ها به زبان انتخاب‌شده نوشته می‌شوند، به هر زبانی که تسک نوشته شده باشد. اگر زبان تسک با زبان تحلیل فرق کند، ترجمهٔ آن هم برای نمایش ساخته می‌شود و متن اصلی Jira هیچ‌وقت تغییر نمی‌کند.

#### PRD

برای هر تسک می‌توان به‌صورت اختیاری PRD یا اسناد کسب‌وکاری اضافه کرد: متن را Paste کنید یا فایل ‎.md، ‎.txt، ‎.pdf یا ‎.docx بارگذاری کنید. تحلیل این اسناد را همراه تسک می‌خواند تا منطق کسب‌وکاری که فقط در PRD آمده هم تحلیل و تست شود.

#### ویرایش و یادگیری

همهٔ خروجی‌ها قابل ویرایش هستند: خلاصه، شکاف‌ها، پرسش‌ها، معیارها، Test Caseها، حالات مرزی، ریسک‌ها، استراتژی و Automation.

- هر اصلاح (ویرایش، حذف، تأیید یا رد پیشنهاد) ثبت می‌شود.
- آخرین اصلاحات هر نوع خروجی دفعهٔ بعد به‌عنوان نمونه به مدل داده می‌شود.
- اصلاحات به‌صورت دوره‌ای به «رهنمود» تبدیل می‌شوند.
- رهنمودها در «تنظیمات ← آنچه تحلیل یاد گرفته» دیده، ویرایش، خاموش یا حذف می‌شوند و می‌توان قواعد دلخواه هم نوشت.

مواردی که کاربر ویرایش یا تأیید کرده در اجراهای بعدی دست نمی‌خورند. Test Caseهای تولیدشده‌ای که دیگر تولید نشوند حذف می‌شوند، مگر اجرا شده باشند که در این صورت «احتمالاً قدیمی» علامت می‌خورند.

#### سرویس‌های هوش مصنوعی

در «تنظیمات ← AI provider» می‌توان چند سرویس اضافه کرد. هر مرحلهٔ تحلیل از سرویس خودش استفاده می‌کند؛ اگر یک سرویس در دسترس نباشد یا محدودیت نرخ بدهد، سرویس بعدی امتحان می‌شود و بازبینی تا جای ممکن با مدلی غیر از مدل نویسندهٔ Test Caseها انجام می‌شود.

| سرویس | توضیح |
|---|---|
| Ollama یا LM Studio | محلی، رایگان و خصوصی. مدل از همان صفحه دانلود می‌شود. |
| Hugging Face، GitHub Models، SambaNova، Cerebras، Mistral | پلن رایگان؛ از ایران بدون VPN در دسترس‌اند. |
| Groq، Google Gemini، OpenRouter | پلن رایگان؛ ممکن است VPN لازم باشد. |

برای سرویس‌های بیرون از شبکه باید اجازهٔ ارسال متن نیازمندی صریحاً داده شود. کلید API رمزنگاری‌شده ذخیره می‌شود و اطلاعات محرمانهٔ داخل متن تسک پیش از ارسال پوشانده می‌شود.

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

صفحه Scenario سه بخش اصلی دارد:

- **Overview:** نام، توضیح، Environment، دکمه‌های Run / Stop / Run again، Progress و خلاصه Stepهای موفق، ناموفق، ردشده و در انتظار.
- **Request Flow:** فهرست فشرده Stepها با Method، URL، وضعیت، Status Code، مدت اجرا و نشانگر اینکه Step از داده کدام Stepهای قبلی استفاده می‌کند.
- **Step Panel:** با انتخاب هر Step باز می‌شود و Tabهای Request، Response، Data Mapping، Assertions، Attempts و Advanced دارد.

#### ورود چند cURL

در دیالوگ «Import cURL» می‌توان چند دستور cURL را (جدا شده با خط خالی) یکجا Paste کرد.

قبل از ذخیره، یک صفحه Review نمایش داده می‌شود که شامل موارد زیر است:

- Method، URL، تعداد Headerها و نوع Body هر Request
- Warningها مثل Header تکراری، Optionهای پشتیبانی‌نشده یا اعمال‌نشده (`-k`، `-L`، `--proxy`) و Request تکراری
- دستورهای Malformed همراه با علت خطا (این دستورها Import نمی‌شوند)
- ارتباط‌های شناسایی‌شده بین Requestها که با Checkbox انتخاب می‌شوند

دستور cURL اصلی در Config هر Step نگه داشته می‌شود. Import هیچ Requestی را اجرا نمی‌کند.

#### شناسایی خودکار وابستگی‌ها

سیستم بررسی می‌کند کدام فیلد یک Request احتمالاً از پاسخ یک Request قبلی می‌آید؛ مثلاً Token در Header `Authorization` یا شناسه کاربر در URL Path. شواهد به ترتیب قدرت:

1. فیلدهایی که Retry خودکار در آخرین اجرا آن‌ها را درست کرده است
2. مقدارهایی که عیناً در یک Response واقعی دیده شده‌اند
3. استنباط فقط از روی Requestها (مثلاً Token صادرشده توسط Login، یا Requestی که یک Entity را می‌سازد یا برمی‌گرداند)؛ این موارد با برچسب «Inferred» نشان داده می‌شوند و هیچ‌وقت High Confidence نیستند

هیچ پیشنهادی تا زمانی که کاربر آن را Accept نکند اعمال نمی‌شود. فیلدی که Mapping ذخیره‌شده دارد پیشنهاد جدید نمی‌گیرد.

#### Data Mapping بدون Variable

کاربر برای اتصال Requestها نیازی به تعریف Variable یا نوشتن JSONPath ندارد:

- در Tab «Request» کنار هر فیلد (Path، Query، Header، JSON Body، Form) گزینه «پر کردن از پاسخ قبلی» وجود دارد.
- در Tab «Response» با Response Explorer (درختی، قابل جستجو، با نمای Raw) می‌توان یک مقدار را انتخاب و «در درخواست بعدی استفاده» کرد.

Mapping روی خود Step ذخیره می‌شود (`config.bindings`) و فقط **محل** مقدار ذخیره می‌شود، نه خود مقدار. در هر اجرا مقدار دوباره از پاسخ همان اجرا خوانده می‌شود. Mappingهای Inferred بعد از اولین اجرای موفق به Path واقعی Pin و Verified می‌شوند.

Tab «Data Mapping» وضعیت هر Mapping را نشان می‌دهد و Mappingهایی را که نیاز به بررسی دارند علامت می‌زند: Step مبدأ حذف شده، بعد از مقصد اجرا می‌شود یا خاموش است، فیلد مقصد دیگر وجود ندارد، یا مقدار در آخرین Response نیست. Mappingها قابل تغییر، خاموش/روشن و حذف هستند. Mapping انتخابی کاربر بر Mapping شناسایی‌شده اولویت دارد و مبدأ همیشه باید یک Step قبلی از همان Scenario باشد.

#### اجرا، Retry و Recovery

- اجرای Scenario به‌صورت Live انجام می‌شود و قابل Cancel است. «اجرا تا همین مرحله» یک Step را همراه با Stepهای قبلی‌اش در یک Context تازه اجرا می‌کند.
- اگر مقدار یک Mapping در اجرای جاری موجود نباشد، Step با وضعیت **Blocked** متوقف می‌شود و Request با مقدار قدیمی ارسال نمی‌شود.
- Retry خودکار حداکثر ۱۰ بار (قابل تنظیم در Advanced) و فقط با مقدارهای Responseهای قبلی انجام می‌شود و هیچ Request یکسانی دوبار ارسال نمی‌شود.
- شرط موفقیت از `expectedStatus` و Assertionهای بعد از Step خوانده می‌شود؛ در نبود آن‌ها هر Status 2xx موفق است.
- Requestهای GET/HEAD/OPTIONS قابل Retry هستند. POST/PUT/PATCH فقط با تنظیم Idempotent یا `Idempotency-Key` Retry می‌شوند و حتی در این حالت فیلدهای Body تغییر نمی‌کنند مگر `allowDataChanges` روشن باشد. DELETE هرگز خودکار Retry نمی‌شود.
- اگر Retry خودکار موفق نشود، اجرا متوقف می‌شود و در Step Panel می‌توان فیلد و مقدار درست را انتخاب کرد، دوباره امتحان کرد و انتخاب را برای اجراهای بعدی ذخیره کرد.
- Tab «Attempts» تاریخچه تلاش‌ها، تغییر هر تلاش، Status و علت توقف را نشان می‌دهد و Request دقیق هر تلاش با Mask شدن مقادیر Sensitive قابل مشاهده است.

Variableها و مقدارهای Response در Scope همان Scenario Execution باقی می‌مانند و بین اجراها یا Scenarioها به اشتراک گذاشته نمی‌شوند. مقادیر Sensitive در UI، Logها و تاریخچه Mask می‌شوند.

HTTP Requestها دارای محدودیت‌هایی مانند Timeout، Response Size Limit و محافظت در برابر آدرس‌های خطرناک (SSRF) هستند.

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

برای تحلیل Test Workspace دست‌کم یک سرویس هوش مصنوعی لازم است. ساده‌ترین گزینهٔ رایگان و خصوصی Ollama است:

```bash
ollama serve
ollama pull qwen3:8b
```

سپس در «تنظیمات ← AI provider» سرویس «Local Ollama» با آدرس `http://localhost:11434` و مدل `qwen3:8b` را ثبت کنید. روی CPU لپ‌تاپ، تحلیل کامل یک تسک بزرگ ممکن است بیش از یک ساعت طول بکشد؛ با یک سرویس رایگان آنلاین چند دقیقه.

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

بعد از این مرحله می‌توانید Demo Flow سیستم را بدون Jira یا Redis اجرا کنید. اگر سرویس هوش مصنوعی تنظیم شده باشد، تحلیل Demo Issue هم در پس‌زمینه شروع می‌شود.

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

# تست‌ها

```bash
npm run test        # Testهای API (Jest)، شامل Scenario Builder و i18n parity
npm run typecheck
npm run lint
npx tsx --test apps/web/lib/curl/parse-curl.spec.ts packages/shared/src/secrets.spec.ts
```

Testهای Scenario از Mock API استفاده می‌کنند و به سرویس واقعی Request ارسال نمی‌کنند.

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
4. در صورت وجود، PRD را اضافه کنید و «تحلیل فارسی» یا «تحلیل انگلیسی» را بزنید.
5. معیارهای پیشنهادی را تأیید، اصلاح یا رد کنید.
6. نتیجه را در زبانه‌های Requirement Analysis، Strategy، Test Cases، Edge Cases و Risks ببینید و هر جا لازم است اصلاح کنید.
7. اصلاحات خود را در «تنظیمات ← آنچه تحلیل یاد گرفته» ببینید.
8. Test Case موردنظر را اجرا کنید.
9. در صورت Failure از Execution یک Bug ایجاد کنید.
10. یک Test Suite ایجاد کنید.
11. وارد بخش Scenario شوید و یک Scenario جدید بسازید.
12. با «Import cURL» چند دستور cURL را Paste کنید، Review را بررسی و ارتباط‌های پیشنهادی را تأیید کنید.
13. Scenario را اجرا کرده و نتیجه Stepها را در Request Flow و Step Panel مشاهده کنید.
14. برای Step ناموفق، از Tab «Data Mapping» یا Response Explorer مقدار درست را از پاسخ یک Step قبلی انتخاب کرده و «اجرا تا همین مرحله» را بزنید.

برای اجرای این Demo Flow نیازی به Jira یا Redis نیست؛ مراحل تحلیل به یک سرویس هوش مصنوعی (مثلاً Ollama محلی) نیاز دارند.