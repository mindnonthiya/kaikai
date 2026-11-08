/** Display-only icon for a menu, picked from its name/category. */
export function menuEmoji(name: string, category: string) {
  const text = `${name} ${category}`;
  if (/ข้าวเปล่า/.test(text)) return "🍚";
  if (/เครป|แพนเค้ก|วาฟเฟิล|โตเกียว/.test(text)) return "🥞";
  if (/ชีส/.test(text)) return "🧀";
  if (/นูเทลล่า|ช็อกโกแลต|โกโก้/.test(text)) return "🍫";
  if (/กล้วย|สตรอว์เบอร์รี|ผลไม้/.test(text)) return "🍌";
  if (/เค้ก|เบเกอรี|ปัง|ครัวซองต์/.test(text)) return "🍰";
  if (/น้ำ|ชา|กาแฟ|เครื่องดื่ม|โซดา|นม/.test(text) && !/น้ำปลา|น้ำซุป|น้ำจิ้ม/.test(text)) return "🥤";
  if (/ขนม|หวาน|ของหวาน/.test(text)) return "🍮";
  if (/กับข้าว|แกง|ต้ม/.test(category)) return "🥘";
  if (/พิเศษ/.test(text)) return "🍛";
  if (/ไก่/.test(text)) return "🍗";
  if (/หมู|แฮม|เบคอน|ไส้กรอก/.test(text)) return "🥓";
  if (/ไข่|ฝอยทอง/.test(text)) return "🥚";
  if (/ปลา|กุ้ง|ทะเล|ปูอัด/.test(text)) return "🐟";
  if (/เส้น|ก๋วยเตี๋ยว|บะหมี่/.test(text)) return "🍜";
  return "🍱";
}
