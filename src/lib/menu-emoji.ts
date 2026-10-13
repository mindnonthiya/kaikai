/** Display-only icon for a menu, picked from its name/category. */
export function menuEmoji(name: string, category: string) {
  const text = `${name} ${category}`;
  if (/ข้าวเปล่า/.test(text)) return "🍚";
  if (/น้ำ|ชา|กาแฟ|เครื่องดื่ม|โซดา/.test(text) && !/น้ำปลา|น้ำซุป/.test(text)) return "🥤";
  if (/ขนม|หวาน|ของหวาน/.test(text)) return "🍮";
  if (/กับข้าว|แกง|ต้ม/.test(category)) return "🥘";
  if (/พิเศษ/.test(text)) return "🍛";
  if (/ไก่/.test(text)) return "🍗";
  if (/หมู/.test(text)) return "🥓";
  if (/ปลา|กุ้ง|ทะเล/.test(text)) return "🐟";
  if (/เส้น|ก๋วยเตี๋ยว|บะหมี่/.test(text)) return "🍜";
  return "🍱";
}
