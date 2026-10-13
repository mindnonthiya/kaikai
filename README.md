# kaikai

เว็บภาษาไทยแบบ mobile-first สำหรับเจ้าของร้านอาหาร ใช้ติดตามยอดขาย ต้นทุนสินค้า ค่าใช้จ่าย และกำไร โดยเก็บเงินเป็นจำนวนเต็มหน่วยสตางค์และเก็บ cost snapshot ทุกครั้งที่ขาย

> สถานะ: MVP สำหรับ local/preview พร้อมโครงสร้าง production แต่ยังไม่ควรเรียกว่า Production-ready จนกว่าจะเชื่อม Supabase project จริงและผ่านรายการตรวจในหัวข้อสุดท้าย

## เทคโนโลยี

- Next.js App Router, TypeScript และ CSS แบบดูแลแยกส่วนได้
- Supabase PostgreSQL, Auth, Private Storage และ RLS
- `@supabase/supabase-js` + `@supabase/ssr` (cookie session)
- Vitest และ Playwright
- Vercel + GitHub Actions

ไม่ใช้ Prisma หรือ Service Role key ในการทำงานทั่วไป

## เริ่มใช้งานในเครื่อง

### 1. ติดตั้งเครื่องมือ

ติดตั้ง Node.js 22+, npm, Git และ Docker Desktop จากเว็บไซต์ทางการ เปิด Docker Desktop ให้ทำงานก่อนเริ่ม Supabase local

### 2. ติดตั้งและตั้งค่า

```bash
npm install
cp .env.example .env.local
npx supabase start
npx supabase db reset
```

นำค่า Project URL และ publishable/anon key ที่ `supabase start` แสดงมาใส่ `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key>
NEXT_PUBLIC_SITE_URL=http://localhost:3000
OCR_PROVIDER=
OCR_API_KEY=
```

`.env.local` ถูก ignore และต้องไม่ commit ลง Git

### 3. สร้าง types และเปิดเว็บ

```bash
npm run db:types
npm run dev
```

เปิด `http://localhost:3000` บัญชี development จาก seed คือ:

- Email: `owner@kaikai.local`
- Password: `KaikaiDemo123!`

บัญชีนี้มีไว้สำหรับ local เท่านั้น ห้ามใช้ใน Production หากยังไม่ใส่ค่า Supabase หน้าเว็บจะเปิดในโหมดข้อมูลตัวอย่างและจะไม่เขียนข้อมูลจริง

## คำสั่งตรวจสอบ

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npx supabase test db
npm run test:e2e
```

`npx supabase db reset` ลบฐานข้อมูล local แล้วสร้างใหม่จาก migration ทุกไฟล์ จากนั้นเรียก `supabase/seed.sql` อัตโนมัติ จึงใช้ตรวจว่าฐานข้อมูลว่างสามารถสร้างซ้ำได้จริง

## โครงสร้างฐานข้อมูลและความปลอดภัย

- `auth.users` จัดการบัญชี และ `profiles.id` อ้างถึง user โดยตรง
- ตารางธุรกิจทั้งหมดมี `owner_id`, index และ RLS สำหรับ SELECT/INSERT/UPDATE/DELETE
- การบันทึกการขายผ่าน `create_sale(jsonb)` ซึ่งใช้ `auth.uid()` เท่านั้น ไม่เชื่อ `owner_id` จาก client
- RPC ตรวจจำนวน/ราคาติดลบ สถานะเมนู เก็บราคาขายและต้นทุน snapshot และ rollback ทั้งรายการอัตโนมัติเมื่อมีข้อผิดพลาด
- bucket `sale-slips` เป็น Private จำกัด 10 MB และรับเฉพาะ JPEG/PNG/WebP
- storage path ต้องขึ้นต้นด้วย user ID เช่น `USER_ID/SALE_ID/RANDOM_UUID.webp`
- เปิดไฟล์ด้วย authenticated download หรือ signed URL อายุสั้นเท่านั้น ฐานข้อมูลเก็บเฉพาะ path
- ต้องตรวจ MIME และ file signature ฝั่ง server ก่อนอัปโหลดจริง รวมถึง hash SHA-256 สำหรับเตือนสลิปซ้ำ
- timestamp เก็บเป็น UTC และ UI แสดงด้วย `Asia/Bangkok`

Schema, function, trigger, index, RLS และ Storage policy อยู่ใน `supabase/migrations` ทั้งหมด ห้ามแก้ Production schema ผ่าน Table Editor หลังเริ่มใช้ migration

## Auth

Production ใช้ Email/Password และปิด public signup ใน `supabase/config.toml` สำหรับ local ส่วน Production ต้องปิดใน Supabase Dashboard → Authentication → Providers ด้วย บัญชีเจ้าของร้านสร้างหรือ invite จาก Dashboard เท่านั้น

ตั้งค่า Auth URL:

- Site URL: URL ของ Vercel Production
- Redirect URLs: local URL, Vercel Preview pattern ที่อนุญาต และ Production URL

Next.js middleware refresh cookie session และส่งผู้ที่ยังไม่ login ไป `/login` เมื่อมี environment variables ครบ การซ่อนหน้าจอไม่ใช่การป้องกันหลัก—RLS เป็นด่านสุดท้ายเสมอ

## OCR

MVP รองรับอัปโหลดสลิปและกรอกข้อมูลเอง โครง `src/lib/ocr` เป็น provider adapter แต่ **ยังไม่มี OCR provider จริง** และไม่มีผลลัพธ์ปลอม Supabase Storage ไม่ได้ทำ OCR

เมื่อตัดสินใจเลือก provider ให้สร้าง adapter ฝั่ง server เท่านั้น อ่าน `OCR_API_KEY` เฉพาะ server และใช้สถานะ `pending → processing → needs_review → confirmed/failed` ผู้ใช้ต้องตรวจและยืนยันก่อนนำผลไปใช้ OCR ไม่ใช่หลักฐานว่าเงินเข้าจริง

## สร้าง Supabase Production

1. สร้าง Supabase project ใหม่ เลือก region ใกล้ผู้ใช้ และเก็บ database password ใน password manager
2. ติดตั้ง Supabase CLI แล้ว login: `npx supabase login`
3. Link project: `npx supabase link --project-ref <project-ref>`
4. ตรวจ migration: `npx supabase db diff --linked`
5. Deploy ครั้งแรก: `npx supabase db push`
6. สร้างบัญชีเจ้าของร้านใน Authentication → Users
7. ตรวจ Storage → `sale-slips` ว่าเป็น Private (migration จะสร้างให้อัตโนมัติ)
8. ปิด public signup และตั้ง Site/Redirect URLs
9. สร้าง types จาก linked project: `npx supabase gen types typescript --linked > src/types/database.generated.ts`

อย่ารัน `supabase/seed.sql` กับ Production

## GitHub, Vercel และ deployment

Workflow ที่กำหนด:

```text
Local → feature branch → GitHub → Vercel Preview → Pull Request → main
                                                              ├─ Vercel Production
                                                              └─ Supabase migration
```

1. สร้าง GitHub repository และ push feature branch (งานนี้ไม่ push ให้อัตโนมัติ)
2. Import repository ใน Vercel และตั้ง `main` เป็น Production branch
3. เพิ่ม `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL` แยกใน Preview/Production
4. Preview ต้องใช้ staging Supabase project แยก หากยังไม่มี staging ให้ไม่ใส่ env เพื่อเปิด read-only demo mode ห้ามชี้ Preview ไป Production
5. เชื่อม Supabase GitHub Integration ตั้ง directory เป็น `supabase` และเปิด deploy to production เฉพาะ `main`
6. ถ้าไม่ใช้ Integration ให้เพิ่ม workflow `supabase db push` และเก็บ `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_ID`, database password ใน GitHub Actions Secrets เท่านั้น ห้ามเขียนลง workflow
7. ทุก PR ต้องผ่าน typecheck, lint, unit tests, build, migration reset และ RLS tests ก่อน merge

Migration ใหม่ควร backward-compatible เพราะเว็บและ schema อาจเผยแพร่ไม่พร้อมกัน

## สำรองและกู้คืน

ใช้ Supabase Dashboard backups ตาม plan ที่เลือก และสำรองแบบ manual ก่อน migration สำคัญ:

```bash
npx supabase db dump --linked -f backup.sql
npx supabase db dump --linked --data-only -f backup-data.sql
```

กู้คืนไปยัง project ใหม่/ว่างและตรวจสอบก่อนเสมอ อย่าทับ Production โดยตรง:

```bash
psql "$DATABASE_URL" -f backup.sql
psql "$DATABASE_URL" -f backup-data.sql
```

ไฟล์ใน Private Storage ต้องสำรองแยกจาก database เพราะ database เก็บเพียง storage path

## สิ่งที่ MVP ทำแล้ว / ยังไม่ทำ

ทำแล้ว: responsive dashboard, sales composer พร้อมคำนวณสด, ประวัติการขาย, เมนู, วัตถุดิบ, ค่าใช้จ่าย, CSV, money utilities, Auth clients/middleware, full schema, RLS, Private Storage policies, atomic sale RPC, seed และ test foundation

ยังไม่ทำ: OCR จริง, inventory depletion, roles พนักงาน, bank verification, tax/accounting integration, printable PDF และการเชื่อม Production จริง

## Checklist ก่อนเรียก Production-ready

- [ ] `.env.local` ไม่ถูก track และไม่มี secret ใน Git history
- [ ] `npx supabase db reset` และ seed ผ่านจากฐานข้อมูลว่าง
- [ ] generated types ถูกสร้างใหม่และตรงกับ schema
- [ ] ทุกตารางเปิด RLS และ test cross-user isolation ผ่าน
- [ ] `sale-slips` เป็น Private และทดสอบ upload/read/delete ข้าม user จริง
- [ ] login, logout, refresh และ route protection ผ่านกับ Production Auth
- [ ] production build และ CI ทุกขั้นผ่าน
- [ ] E2E บันทึก/แก้ไข/ยกเลิกการขาย และค่าใช้จ่ายผ่านกับ local Supabase
- [ ] mobile viewport ไม่มี horizontal overflow
- [ ] เปลี่ยนต้นทุนแล้วรายการขายเก่าไม่เปลี่ยน
- [ ] Dashboard อัปเดตจากรายการขายจริง
- [ ] ทดสอบ backup และ restore ไปยังฐานข้อมูลทดสอบ

รายละเอียดการวิเคราะห์ หน้าจอ สูตร และ MVP อยู่ที่ `docs/PRODUCT_PLAN.md`
