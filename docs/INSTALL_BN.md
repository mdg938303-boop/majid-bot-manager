# Majid Bot Manager V2 — ইনস্টলেশন গাইড (শুধু Android ফোন দিয়ে)

> ⚠ **আগে খরচ জেনে নিন:** একটি সবসময়-চালু বট ≈ $43–50/মাস খরচ করতে পারে (ওয়েব ≈ $7 + ডাটাবেস ≈ $6 + Sandbox ≈ $30+)। অর্থাৎ $50 ক্রেডিট প্রায় ১ মাস চলবে। বিস্তারিত: `docs/COSTS.md`। আপনার ক্রেডিট সব সার্ভিসে কাজ করবে কি না Render Dashboard → Billing-এ নিজে দেখে নিন।
> এই গাইডের কিছু ধাপ (GitHub/Render-এর মোবাইল স্ক্রিন) আমি নিজে চালিয়ে যাচাই করতে পারিনি; স্ক্রিনের নাম একটু আলাদা হতে পারে।

## ১. GitHub রিপোজিটরি তৈরি
1. Chrome খুলে github.com → Sign up/Login।
2. উপরে ডানে **+ → New repository**।
3. নাম দিন `majid-bot-manager`, **Private** বাছুন, **Create repository**।

## ২. Android থেকে ফাইল আপলোড
GitHub-এর ওয়েবসাইট ZIP খুলে দেয় না এবং ফোনে ফোল্ডার আপলোড করা যায় না। তাই সবচেয়ে নির্ভরযোগ্য উপায় **Termux**:
1. F-Droid থেকে **Termux** ইনস্টল করুন (Play Store-এর সংস্করণ পুরনো)।
2. GitHub → Settings → Developer settings → **Personal access tokens (classic)** → `repo` অনুমতিসহ একটি টোকেন বানান। **এটি কাউকে দেবেন না।**
3. প্রজেক্ট ZIP-টি ফোনের Download ফোল্ডারে রাখুন। Termux-এ:
```
termux-setup-storage
pkg install -y git unzip
cd ~ && unzip ~/storage/downloads/majid-bot-manager-v2.zip
cd majid-bot-manager-v2 2>/dev/null || cd mbm
git init && git branch -M main
git add . && git commit -m "Majid Bot Manager V2"
git remote add origin https://github.com/YOUR_USERNAME/majid-bot-manager.git
git push -u origin main
```
পাসওয়ার্ড চাইলে আপনার **Personal access token** পেস্ট করুন।
4. `.env` ফাইল কখনো আপলোড করবেন না (`.gitignore` এটি আটকায়)।

## ৩. GitHub-কে Render-এর সাথে যুক্ত করা
1. dashboard.render.com → Sign in with GitHub।
2. **New + → Blueprint** → আপনার `majid-bot-manager` রিপো বাছুন → Connect।
3. Render `render.yaml` পড়ে একটি **Web Service** ও একটি **PostgreSQL** দেখাবে। **খরচ (≈ $7 + ≈ $6) দেখে নিন, তারপর** Apply।

## ৪. PostgreSQL
Blueprint নিজেই `mbm-db` তৈরি করে এবং `DATABASE_URL` স্বয়ংক্রিয়ভাবে ওয়েব সার্ভিসে বসায়। আলাদা কিছু করতে হবে না।

## ৫. Environment Variables (Render Dashboard → Service → Environment)
| নাম | কী দিতে হবে |
|---|---|
| `DATABASE_URL` | স্বয়ংক্রিয় — হাতে দেবেন না |
| `ENCRYPTION_KEY` | স্বয়ংক্রিয় (Render বানায়)। **পরে কখনো বদলাবেন না**, বদলালে সংরক্ষিত টোকেন পড়া যাবে না |
| `ADMIN_EMAIL` | আপনার অ্যাডমিন ইমেইল |
| `ADMIN_PASSWORD` | কমপক্ষে ১০ অক্ষর, অক্ষর + সংখ্যা। কোথাও লিখে প্রকাশ করবেন না |
| `RENDER_API_KEY` | Render → Account Settings → **API Keys** → Create |
| `RENDER_WORKSPACE_ID` | Render → Workspace Settings-এ থাকা ID (দেখতে `tea-…`) |
| `RENDER_SANDBOX_GROUP_ID` | ঐচ্ছিক। Sandbox Group তৈরি করলে তার ID |
| `NODE_VERSION` | `22` (দেওয়া আছে) |
Optional: `LOG_POLL_SECONDS` (ডিফল্ট ৫), `MAX_UPLOAD_MB` (২৫), `SESSION_DAYS` (৭)।

## ৬. Render Sandbox অ্যাক্সেস যাচাই
1. Render Dashboard-এ **Sandboxes** (বা New + → Sandbox Group) অপশন আছে কি না দেখুন। না থাকলে আপনার ওয়ার্কসপেসে Sandboxes চালু নেই।
2. অ্যাপ চালু হলে **Dashboard পেজে** হলুদ বক্স দেখালে (“Execution runtime is not available”) তাতে কারণ লেখা থাকবে। এই অবস্থায় বট ডিপ্লয় করা যাবে না — অ্যাপ নকল সফলতা দেখায় না।
3. `Admin Panel → system` এ "Runtime: available" দেখতে হবে।

## ৭. Web Service ডিপ্লয়
Blueprint Apply করলে বিল্ড শুরু হয় (৫–১০ মিনিট)। **Logs** ট্যাবে `Majid Bot Manager listening` ও `Initial admin created` দেখুন। তারপর Render-এর দেওয়া `https://….onrender.com` লিংক খুলুন।

## ৮. অ্যাডমিন অ্যাকাউন্ট
`ADMIN_EMAIL`/`ADMIN_PASSWORD` দিয়ে লগইন করুন। প্রথম বুটে একবারই অ্যাডমিন তৈরি হয়। লগইন করে **Account Settings** থেকে পাসওয়ার্ড বদলান, তারপর Render থেকে `ADMIN_PASSWORD` মুছে ফেলতে পারেন।

## ৯. নমুনা Telegram বট টেস্ট
1. Telegram-এ **@BotFather** → `/newbot` → টোকেন কপি করুন।
2. অ্যাপে **Add New Bot** → নাম + টোকেন → Verify & create (Telegram `getMe` দিয়ে যাচাই হবে)।
3. বটের পেজে **Project ZIP** থেকে `examples/sample-bot.zip` আপলোড করুন (কোনো ডিপেন্ডেন্সি লাগে না)।
4. **Console** ট্যাবে build → starting → “Process is running” দেখুন। সফলতা দেখাবে শুধু প্রসেস সত্যিই চালু থাকলে।
5. Telegram-এ বটকে মেসেজ দিন — `Echo: …` ফেরত এলে সফল।
6. কাজ শেষে **Free sandbox** চাপুন, নাহলে বিল চলতে থাকবে।
যদি “Required tool python3 is not installed” আসে, Sandbox ইমেজে সেই ভাষা নেই — Render ডকুমেন্টেশন দেখুন।

## ১০. লগ ও ক্রেডিট মনিটর
- **খরচ কমাতে:** Admin → system → "Auto-stop any sandbox after running (hours)" ডিফল্ট **৮**। ৮ ঘণ্টা পর Sandbox নিজে বন্ধ হবে; আবার চালাতে **Start** চাপুন। ২৪ ঘণ্টা চালু রাখতে চাইলে `0` দিন।
- বটের **Console** ট্যাব: stdout/stderr/build/system ফিল্টার, সার্চ, auto-scroll। রানটাইম লগ প্রতি ~৫ সেকেন্ডে আসে (লাইভ স্ট্রিম নয়, নিকট-লাইভ)।
- Admin → system: কস্ট **অনুমান** (আসল বিল নয়)। আসল ব্যবহার ও বাকি ক্রেডিট দেখুন Render → **Billing**।
- জরুরি: Admin → **Stop everything now** (Kill switch) সব Sandbox বন্ধ করে।

## ১১. ব্যাকআপ
- **প্রজেক্ট ফাইল:** বটের পেজ → *Download project (.tar.gz)*।
- **ডাটাবেস:** Render → Postgres → **Recovery/Backups** (পেইড প্ল্যানে স্বয়ংক্রিয় ব্যাকআপ আছে; পুনরুদ্ধারের নিয়ম Render ডক দেখুন)।
- `ENCRYPTION_KEY` একটি নিরাপদ জায়গায় আলাদা কপি রাখুন।

## ১২. GitHub থেকে আপডেট
Termux-এ পরিবর্তন করে `git add . && git commit -m "update" && git push`। `autoDeploy: false` থাকায় Render → Service → **Manual Deploy → Deploy latest commit** চাপুন।

## নতুন সুবিধা (আপডেটের পর)
- **ভাষা:** মেনুর "English / বাংলা" বোতামে ভাষা বদলানো যায়।
- **Runtime check:** Admin → Overview → "পরীক্ষা চালান" চাপলে দেখা যাবে Sandbox-এ Python, Node.js, PHP আছে কি না।
- **বটের ডেটা:** বটের কোডে `DATA_DIR` ফোল্ডারে ফাইল লিখলে (সর্বোচ্চ ১০ MB) সেটা বন্ধ/Redeploy-এর সময় ও প্রতি ১০ মিনিটে সংরক্ষিত হয়ে পরের ডিপ্লয়ে ফিরে আসে। বটের Settings-এ দেখা ও ডাউনলোড করা যায়।
- **Webhook মোড:** বটের Settings → Webhook মোড চালু করে পোর্ট দিন, তারপর Redeploy করুন।
- **ডেভেলপারের জন্য:** `docs/DEVELOPER_BRIEF.md` ফাইলটি তাকে পাঠিয়ে দিন।
