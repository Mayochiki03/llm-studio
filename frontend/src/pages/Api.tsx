// เชื่อมต่อระบบอื่น: คีย์ API (สร้าง/ปิด/ลบ) และคู่มือเรียกใช้สั้นๆ (0.9 จะเพิ่มสิทธิ์ต่อคีย์ สถิติ และตัวทดลองเรียก)
import Topbar from "../components/Topbar";
import ApiKeysCard from "../components/ApiKeysCard";

export default function Api() {
  return (
    <div className="flex-1 overflow-y-auto">
      <Topbar title="เชื่อมต่อระบบอื่น" subtitle="ให้เว็บหรือ LINE บอทเรียกโมเดลและคลังความรู้ของเราผ่าน API" />
      <div className="p-4 md:p-8 max-w-3xl space-y-5">
        <ApiKeysCard />
      </div>
    </div>
  );
}
