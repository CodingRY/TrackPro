# เปิดใช้งานระบบ Admin ของ TrackPro

หน้า Admin และคำสั่งจัดการบัญชีถูกแยกเป็นฝั่งเว็บและ Supabase Edge Function เพื่อไม่ให้ `service_role` key รั่วไปยังเบราว์เซอร์

## ติดตั้งครั้งแรก

1. นำ migration `supabase/migrations/202607300001_admin_access.sql` ไปรันใน Supabase SQL Editor หรือใช้ `supabase db push`
2. Deploy ฟังก์ชันด้วย `supabase functions deploy admin-users`
3. สมัครบัญชีที่จะใช้เป็น Admin ผ่านหน้า `register.html` ตามปกติ
4. เปิด `supabase/bootstrap-admin.sql` เปลี่ยน `admin@example.com` เป็นอีเมลจริง แล้วรันใน Supabase SQL Editor
5. ออกจากระบบและเข้าสู่ระบบใหม่ บัญชี Admin จะถูกส่งไป `admin.html`

## ความปลอดภัย

- ห้ามใส่ `SUPABASE_SERVICE_ROLE_KEY` ใน HTML หรือ JavaScript ฝั่งเว็บ
- Edge Function ใช้ secret ที่ Supabase จัดเตรียมให้บนเซิร์ฟเวอร์
- ฟังก์ชันตรวจ JWT และตรวจ `profiles.role = 'admin'` ซ้ำก่อนทุกคำสั่ง
- ระบบป้องกันการลบบัญชี Admin ที่กำลังใช้งานและ Admin คนสุดท้าย
