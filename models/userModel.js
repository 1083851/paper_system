import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  group: { type: String, default: 'AI' }, // 'AI' 或 'Control'
  
  // 儲存積木狀態 (XML 字串)
  lastXml: { type: String, default: "" },

  // ★★★ 新增：角色權限 (admin = 管理員, student = 學生) ★★★
  role: { type: String, default: 'student' },

  // ★★★ 新增：最後活動時間 (用來判斷是否在線上) ★★★
  lastActive: { type: Date, default: Date.now },

  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
export default User;